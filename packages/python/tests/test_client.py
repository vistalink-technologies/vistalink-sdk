import json

import httpx
import pytest

from conftest import booking, job
import respx
from vistalink import VistaLink, VistaLinkError, booking_next_step, models, parse_ndjson
from vistalink import models as m


def body(call):
    return json.loads(call.request.content) if call.request.content else None


def test_auth_header_and_typed_response(vl):
    route = vl.router.post("/v2/hotels/resolve").respond(200, json={
        "request_id": "req_1", "billing": None,
        "results": [{"input": 0, "status": "resolved", "hotel_id": "h1", "match": "exact", "basis": "booking_slug"}]})
    r = vl.hotels.resolve({"identifiers": [{"booking_url": "https://www.booking.com/hotel/it/umilta-36.html"}]})
    assert isinstance(r, models.ResolveResponse)
    assert r.results[0].hotel_id == "h1"
    req = route.calls.last.request
    assert req.headers["authorization"] == "Bearer vl_test_abc"
    assert req.headers["x-vistalink-client"].startswith("vistalink-python/")


def test_models_are_accepted_as_bodies(vl):
    route = vl.router.post("/v2/search").respond(200, json={"request_id": "r", "search_id": "s", "status": "completed", "hotels": []})
    vl.search.run(models.SearchRequest(query="rome", limit=5))
    assert body(route.calls.last) == {"query": "rome", "limit": 5}  # only fields the caller set


def test_query_params(vl):
    route = vl.router.get("/v2/hotels/h1").respond(200, json={"request_id": "r", "hotel_id": "h1"})
    vl.hotels.get("h1", sections=["core", "rooms"], check_in="2026-11-14", search_id="srch_1", currency=None)
    params = route.calls.last.request.url.params
    assert params["sections"] == "core,rooms"
    assert params["search_id"] == "srch_1"
    assert "currency" not in params


def test_retry_429_honours_retry_after(vl, sleeps):
    route = vl.router.get("/v2/amenities")
    route.side_effect = [
        httpx.Response(429, headers={"Retry-After": "2"}, json={"error": {"code": "rate_limited", "message": "slow"}}),
        httpx.Response(200, json={"request_id": "r2", "amenities": []}),
    ]
    assert vl.catalog.amenities().request_id == "r2"
    assert route.call_count == 2
    assert sleeps == [2.0]


def test_retry_503_backoff_then_error(vl, sleeps):
    route = vl.router.post("/v2/search").respond(503, json={"error": {"code": "unavailable", "message": "down", "request_id": "req_x"}})
    with pytest.raises(VistaLinkError) as ei:
        vl.search.run({"query": "x"})
    assert route.call_count == 4  # 1 + 3 retries
    assert ei.value.code == "unavailable" and ei.value.request_id == "req_x" and ei.value.status == 503
    assert len(sleeps) == 3 and 0.25 <= sleeps[0] <= 0.5 and 0.5 <= sleeps[1] <= 1.0


def test_no_retry_on_other_errors(vl):
    route = vl.router.get("/v2/engines").respond(502, json={"error": {"code": "upstream_error", "message": "x"}})
    with pytest.raises(VistaLinkError):
        vl.catalog.engines()
    assert route.call_count == 1


def test_network_errors_retry_only_when_repeatable(vl):
    get = vl.router.get("/v2/jobs")
    get.side_effect = [httpx.ConnectError("boom"), httpx.Response(200, json={"request_id": "r", "jobs": []})]
    vl.jobs.list()
    assert get.call_count == 2

    post = vl.router.post("/v2/search")
    post.side_effect = httpx.ConnectError("boom")
    with pytest.raises(VistaLinkError) as ei:
        vl.search.run({"query": "x"})
    assert ei.value.code == "network_error"
    assert post.call_count == 1


def test_idempotency_key_generated_and_reused(vl):
    route = vl.router.post("/v2/bookings")
    route.side_effect = [httpx.Response(503, json={"error": {"code": "unavailable", "message": "x"}}),
                         httpx.Response(202, json=booking("queued"))]
    b = vl.bookings.create({"hotel_id": "h1", "offer_id": "off_1", "stay": {"check_in": "2026-11-14", "check_out": "2026-11-16"},
                            "guests": [{"room": 0, "lead": {"first_name": "Ada", "last_name": "Rossi", "email": "ada@example.com", "phone": "+390600000000"}}],
                            "payment": {"mode": "checkout"}})
    assert b.booking_id == "bk_1"
    k1 = route.calls[0].request.headers["idempotency-key"]
    assert len(k1) == 36
    assert route.calls[1].request.headers["idempotency-key"] == k1


def test_idempotency_rules(vl):
    rates = vl.router.post("/v2/rates")
    rates.side_effect = [httpx.Response(202, json=job("queued")), httpx.Response(200, json={"request_id": "r", "results": []})]
    stay = {"check_in": "2026-11-14", "check_out": "2026-11-16"}
    j = vl.rates.live({"hotels": ["h1"], "stay": stay}, idempotency_key="mine")
    assert isinstance(j, models.Job)
    r = vl.rates.cached({"hotels": ["h1"], "stay": stay})
    assert isinstance(r, models.RatesResponse)
    assert rates.calls[0].request.headers["idempotency-key"] == "mine"
    assert body(rates.calls[0])["freshness"] == "live"
    assert "idempotency-key" not in rates.calls[1].request.headers

    rec = vl.router.post("/v2/rooms/reconcile").respond(202, json=job("queued", kind="rooms.reconcile"))
    vl.rooms.reconcile({"hotel_id": "h1", "sources": [{"kind": "booking_url", "url": "https://www.booking.com/hotel/it/x.html"}]})
    assert "idempotency-key" in rec.calls.last.request.headers


def test_error_mapping(vl):
    vl.router.post("/v2/rates").respond(403, json={"error": {"code": "forbidden", "message": "third-party channel",
                                                             "request_id": "req_9", "details": {"reason": "enterprise_only"}}})
    with pytest.raises(VistaLinkError) as ei:
        vl.rates.cached({"hotels": ["h1"], "stay": {"check_in": "2026-11-14", "check_out": "2026-11-15"}, "channel": "third_party"})
    e = ei.value
    assert (e.code, e.status, e.request_id, e.details, e.message) == ("forbidden", 403, "req_9", {"reason": "enterprise_only"}, "third-party channel")


def test_error_fallbacks(vl):
    vl.router.get("/v2/engines").respond(402, text="nope", headers={"X-Request-Id": "req_h"})
    with pytest.raises(VistaLinkError) as ei:
        vl.catalog.engines()
    assert (ei.value.code, ei.value.request_id) == ("insufficient_credit", "req_h")

    vl.router.post("/v2/search").respond(422, json={"detail": [{"loc": ["body", "limit"], "msg": "too big", "type": "x"}]})
    with pytest.raises(VistaLinkError) as ei:
        vl.search.run({"limit": 999})
    assert ei.value.code == "bad_request" and ei.value.details["fields"][0]["loc"] == ["body", "limit"]


def test_jobs_wait(vl, sleeps):
    route = vl.router.get("/v2/jobs/job_1")
    route.side_effect = [httpx.Response(200, json=job("queued")), httpx.Response(200, json=job("running")),
                         httpx.Response(200, json=job("succeeded", result={"results": []}))]
    seen = []
    j = vl.jobs.wait("job_1", interval=0.1, on_poll=lambda x: seen.append(x.status))
    assert j.status == "succeeded" and j.result == {"results": []}
    assert seen == ["queued", "running", "succeeded"]
    assert sleeps == [0.1, pytest.approx(0.15)]


def test_jobs_wait_failure_and_timeout(vl):
    vl.router.get("/v2/jobs/job_1").respond(200, json=job("failed", error={"code": "upstream_error", "message": "engine timeout"}))
    with pytest.raises(VistaLinkError) as ei:
        vl.jobs.wait("job_1")
    assert ei.value.code == "job_failed" and ei.value.message == "engine timeout"
    assert vl.jobs.wait("job_1", raise_on_failure=False).status == "failed"

    vl.router.get("/v2/jobs/job_2").respond(200, json=job("running", job_id="job_2"))
    with pytest.raises(VistaLinkError) as ei:
        vl.jobs.wait("job_2", timeout=0)
    assert ei.value.code == "timeout"


def test_bookings_wait_stops_at_requires_payment(vl):
    route = vl.router.get("/v2/bookings/bk_1")
    route.side_effect = [
        httpx.Response(200, json=booking("queued")),
        httpx.Response(200, json=booking("requires_payment", payment={
            "mode": "checkout", "status": "pending", "checkout_url": "https://checkout.stripe.com/c/pay/cs_1", "payee": "property"})),
    ]
    b = vl.bookings.wait("bk_1", interval=0)
    assert b.status == "requires_payment" and "checkout.stripe.com" in b.payment.checkout_url


def test_pagination(vl):
    route = vl.router.get("/v2/jobs")
    route.side_effect = [
        httpx.Response(200, json={"request_id": "r1", "jobs": [job("succeeded", job_id="a")], "next_cursor": "c2"}),
        httpx.Response(200, json={"request_id": "r2", "jobs": [job("failed", job_id="b")], "next_cursor": None}),
    ]
    assert [j.job_id for j in vl.jobs.list_all(kind="rates.live")] == ["a", "b"]
    assert "cursor" not in route.calls[0].request.url.params
    assert route.calls[1].request.url.params["cursor"] == "c2"
    assert route.calls[1].request.url.params["kind"] == "rates.live"


def test_webhook_create_201(vl):
    vl.router.post("/v2/webhooks").respond(201, json={"request_id": "r", "webhook_id": "wh_1", "url": "https://x.example/h",
                                                      "events": ["booking.updated"], "created_at": "2026-10-07T12:00:00Z", "secret": "whsec_1"})
    assert vl.webhooks.create({"url": "https://x.example/h", "events": ["booking.updated"]}).secret == "whsec_1"


def test_delete_answered_204_returns_none(vl):
    vl.router.delete("/v2/webhooks/wh_1").respond(204)
    assert vl.webhooks.delete("wh_1") is None


NDJSON = '{"hotel_id":"h1","status":"observed"}\n{"hotel_id":"h2","status":"unavailable"}\n'


def test_job_download_uses_result_endpoint_when_result_url_is_null(vl):
    route = vl.router.get("/v2/jobs/job_1/result").respond(200, text=NDJSON, headers={"content-type": "application/x-ndjson"})
    j = m.Job.model_validate(job("succeeded", kind="rates.batch", result_url=None))
    text = vl.jobs.download(j)
    assert text == NDJSON
    assert route.calls[0].request.headers["authorization"] == "Bearer vl_test_abc"
    assert parse_ndjson(text) == [{"hotel_id": "h1", "status": "observed"}, {"hotel_id": "h2", "status": "unavailable"}]


def test_job_download_signed_url_without_key():
    with respx.mock(assert_all_called=False) as router:
        route = router.get("https://files.test/r.ndjson").respond(200, text=NDJSON)
        with VistaLink("vl_test_abc", base_url="https://api.test", sleep=lambda s: None) as c:
            j = m.Job.model_validate(job("succeeded", kind="rates.batch", result_url="https://files.test/r.ndjson?sig=abc"))
            assert c.jobs.download(j) == NDJSON
        req = route.calls[0].request
        assert "authorization" not in req.headers
        assert req.url.params["sig"] == "abc"


def test_wait_for_result(vl):
    route = vl.router.get("/v2/jobs/job_1")
    route.side_effect = [
        httpx.Response(200, json=job("running", kind="rates.batch")),
        httpx.Response(200, json=job("succeeded", kind="rates.batch", result_url=f"https://api.test/v2/jobs/job_1/result")),
    ]
    vl.router.get("/v2/jobs/job_1/result").respond(200, text=NDJSON)
    j, text = vl.jobs.wait_for_result("job_1", interval=0)
    assert j.status == "succeeded" and text == NDJSON


def test_booking_next_step_modes_and_final_states():
    def bk(status, **extra):
        return m.Booking.model_validate(booking(status, **extra))

    s = booking_next_step(bk("requires_payment", payment={"mode": "checkout", "status": "pending",
                                                           "checkout_url": "https://checkout.stripe.com/c/pay/cs_1"}))
    assert (s.action, s.url) == ("checkout", "https://checkout.stripe.com/c/pay/cs_1")
    s = booking_next_step(bk("requires_user_action", payment={"mode": "handoff", "status": "pending"},
                             handoff={"url": "https://bookings.vistalink.com/s/abc"}))
    assert (s.action, s.url) == ("handoff", "https://bookings.vistalink.com/s/abc")
    s = booking_next_step(bk("requires_user_action", payment={"mode": "external", "status": "pending"},
                             handoff={"url": "https://engine.test/prefilled"}))
    assert (s.action, s.url) == ("external", "https://engine.test/prefilled")
    assert booking_next_step(bk("processing")).action == "wait"
    for st in ("confirmed", "failed", "expired", "canceled"):
        assert booking_next_step(bk(st)).action == "done"
    failed = bk("failed", failure={"reason": "payment_unavailable"})
    assert failed.failure.reason == "payment_unavailable"


def test_bookings_wait_stops_at_canceled(vl):
    route = vl.router.get("/v2/bookings/bk_1")
    route.side_effect = [httpx.Response(200, json=booking("queued")), httpx.Response(200, json=booking("canceled"))]
    assert vl.bookings.wait("bk_1", interval=0).status == "canceled"


def test_booking_create_sends_payment_mode_and_key(vl):
    route = vl.router.post("/v2/bookings").respond(202, json=booking("queued"))
    vl.bookings.create({"hotel_id": "h1", "offer_id": "off_1", "stay": {"check_in": "2026-11-14", "check_out": "2026-11-16"},
                        "guests": [{"room": 0, "lead": {"first_name": "Ada", "last_name": "Rossi", "email": "ada@example.com", "phone": "+390600000000"}}],
                        "payment": {"mode": "external"}})
    req = route.calls[0].request
    assert req.headers["idempotency-key"]
    assert json.loads(req.content)["payment"] == {"mode": "external"}


def test_catalog_openapi_is_public(vl):
    vl.router.get("/v2/openapi.json").respond(200, json={"openapi": "3.1.0"})
    assert vl.catalog.openapi() == {"openapi": "3.1.0"}
