import httpx
import pytest

from conftest import booking, job
from vistalink import VistaLinkError, models


async def test_async_auth_retry_and_idempotency(avl, sleeps):
    route = avl.router.post("/v2/rates/batch")
    route.side_effect = [httpx.Response(429, headers={"Retry-After": "1"}, json={"error": {"code": "rate_limited", "message": "x"}}),
                         httpx.Response(202, json=job("queued", kind="rates.batch"))]
    j = await avl.rates.batch({"hotels": ["h1"], "stays": [{"check_in": "2026-11-14", "check_out": "2026-11-16"}]})
    assert isinstance(j, models.Job) and j.kind == "rates.batch"
    assert sleeps == [1.0]
    reqs = [c.request for c in route.calls]
    assert reqs[0].headers["authorization"] == "Bearer vl_test_abc"
    assert reqs[0].headers["idempotency-key"] == reqs[1].headers["idempotency-key"]


async def test_async_wait_and_errors(avl):
    route = avl.router.get("/v2/jobs/job_1")
    route.side_effect = [httpx.Response(200, json=job("running")), httpx.Response(200, json=job("succeeded"))]
    assert (await avl.jobs.wait("job_1", interval=0)).status == "succeeded"

    avl.router.get("/v2/bookings/bk_9").respond(404, json={"error": {"code": "not_found", "message": "no", "request_id": "req_4"}})
    with pytest.raises(VistaLinkError) as ei:
        await avl.bookings.get("bk_9")
    assert (ei.value.code, ei.value.status, ei.value.request_id) == ("not_found", 404, "req_4")


async def test_async_pagination_and_booking_wait(avl):
    route = avl.router.get("/v2/jobs")
    route.side_effect = [httpx.Response(200, json={"request_id": "r", "jobs": [job("succeeded", job_id="a")], "next_cursor": "n"}),
                         httpx.Response(200, json={"request_id": "r", "jobs": [job("succeeded", job_id="b")]})]
    assert [j.job_id async for j in avl.jobs.list_all()] == ["a", "b"]

    b = avl.router.get("/v2/bookings/bk_1")
    b.side_effect = [httpx.Response(200, json=booking("processing")), httpx.Response(200, json=booking("confirmed"))]
    assert (await avl.bookings.wait("bk_1", interval=0)).status == "confirmed"


async def test_async_download_and_delete(avl):
    avl.router.get("/v2/jobs/job_1").respond(200, json=job("succeeded", kind="rates.batch", result_url=None))
    avl.router.get("/v2/jobs/job_1/result").respond(200, text='{"hotel_id":"h1"}\n')
    j, text = await avl.jobs.wait_for_result("job_1", interval=0)
    assert j.kind == "rates.batch" and text == '{"hotel_id":"h1"}\n'
    avl.router.delete("/v2/webhooks/wh_1").respond(204)
    assert await avl.webhooks.delete("wh_1") is None
