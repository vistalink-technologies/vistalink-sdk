"""Request building shared by the sync and async clients."""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Mapping, TypeVar
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel

from . import models as m
from ._errors import VistaLinkError

__version__ = "0.0.1"
DEFAULT_BASE_URL = "https://api.vistalink.com"
JOB_TERMINAL = frozenset({"succeeded", "failed", "canceled"})
#: Booking states that never change again.
BOOKING_FINAL = frozenset({"confirmed", "failed", "expired", "canceled"})
#: Quote states that never change again.
QUOTE_FINAL = frozenset({"accepted", "completed", "no_response", "declined", "cancelled", "failed"})
#: Where ``quotes.wait`` stops by default: the first offer, or the quote closing without one.
QUOTE_STOP_DEFAULT = ("offer_received", "accepted", "completed", "no_response", "declined", "cancelled", "failed")
BOOKING_STOP_DEFAULT = (
    "requires_payment",
    "requires_user_action",
    "confirmed",
    "confirmation_pending",
    "failed",
    "expired",
    "canceled",
)
#: ``payment.mode`` on ``POST /v2/bookings``. The guest always pays the property.
PAYMENT_MODES = ("checkout", "handoff", "external")


@dataclass(frozen=True)
class BookingNextStep:
    """What the caller does next with a booking.

    - ``checkout``: ``requires_payment`` → send the guest to ``payment.checkout_url``.
    - ``handoff``: ``requires_user_action`` → the hosted guest session at ``handoff.url``.
    - ``external``: ``requires_user_action`` → the engine's own prefilled page at ``handoff.url``.
    - ``wait``: ``queued | processing | confirmation_pending``; poll or listen for ``booking.updated``.
    - ``done``: ``confirmed | failed | expired | canceled`` (see ``failure.reason``).
    """

    action: Literal["checkout", "handoff", "external", "wait", "done"]
    url: str | None = None
    expires_at: Any = None


def booking_next_step(booking: m.Booking) -> BookingNextStep:
    pay = booking.payment
    if booking.status == "requires_payment" and pay and pay.checkout_url:
        return BookingNextStep("checkout", pay.checkout_url, pay.expires_at)
    if booking.status == "requires_user_action" and booking.handoff and booking.handoff.url:
        action = "external" if pay and pay.mode == "external" else "handoff"
        return BookingNextStep(action, booking.handoff.url, booking.handoff.expires_at)
    return BookingNextStep("done" if booking.status in BOOKING_FINAL else "wait")


def parse_ndjson(text: str) -> list[dict[str, Any]]:
    """Split an NDJSON document (a ``rates.batch`` result) into rows."""
    return [json.loads(line) for line in text.splitlines() if line.strip()]

T = TypeVar("T", bound=BaseModel)
Body = BaseModel | Mapping[str, Any]


def dump(body: Body | None) -> Any:
    if body is None:
        return None
    if isinstance(body, BaseModel):
        return body.model_dump(mode="json", by_alias=True, exclude_unset=True)
    return dict(body)


def clean_query(query: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not query:
        return None
    out: dict[str, Any] = {}
    for k, v in query.items():
        if v is None:
            continue
        if isinstance(v, (list, tuple)):
            v = ",".join(str(x) for x in v)
        elif isinstance(v, bool):
            v = "true" if v else "false"
        out[k] = v
    return out


@dataclass
class Spec:
    """One API call: how to send it and how to parse each 2xx status."""

    method: str
    path: str
    parse: Mapping[int, Callable[[Any], Any]]
    json: Any = None
    params: dict[str, Any] | None = None
    idempotency_key: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    #: Return the body as text (NDJSON) instead of parsing JSON.
    raw: bool = False
    #: ``path`` is an absolute URL fetched without the API key (signed result links).
    anonymous: bool = False

    @property
    def repeatable(self) -> bool:
        return self.method in ("GET", "DELETE") or self.idempotency_key is not None


def model(cls: type[T]) -> Callable[[Any], T]:
    return cls.model_validate


def new_idempotency_key() -> str:
    return str(uuid.uuid4())


def is_job(value: Any) -> bool:
    return isinstance(value, m.Job)


def parse_response(spec: Spec, response: httpx.Response) -> Any:
    try:
        body = response.json() if response.content else None
    except ValueError:
        body = response.text
    if not response.is_success:
        if spec.anonymous:
            raise VistaLinkError("upstream_error", f"Downloading result_url failed (HTTP {response.status_code})",
                                 status=response.status_code)
        raise VistaLinkError.from_response(response.status_code, body, response.headers)
    if spec.raw:
        return response.text
    if response.status_code == 204:
        return None  # no body (e.g. a DELETE answered 204)
    parser = spec.parse.get(response.status_code)
    if parser is None:
        parser = next(iter(spec.parse.values()))
    if body is None:
        raise VistaLinkError("invalid_response", f"Empty response body (HTTP {response.status_code})",
                             status=response.status_code, request_id=response.headers.get("x-request-id"))
    return parser(body)


def job_failure(job: m.Job) -> VistaLinkError:
    err = job.error
    return VistaLinkError(
        "job_canceled" if job.status == "canceled" else "job_failed",
        (err.message if err else None) or f"Job {job.job_id} {job.status}",
        request_id=job.request_id,
        details={"job_id": job.job_id, "kind": job.kind, "error": err.model_dump() if err else None},
    )


# ---------------------------------------------------------------------------
# Specs, one per operation
# ---------------------------------------------------------------------------

def _idem(key: str | None) -> str:
    return key or new_idempotency_key()


def resolve(body: Body) -> Spec:
    return Spec("POST", "/v2/hotels/resolve", {200: model(m.ResolveResponse)}, json=dump(body))


def hotel(hotel_id: str, query: Mapping[str, Any] | None) -> Spec:
    return Spec("GET", f"/v2/hotels/{hotel_id}", {200: model(m.HotelDetailResponse)}, params=clean_query(query))


def search(body: Body) -> Spec:
    return Spec("POST", "/v2/search", {200: model(m.SearchResponse)}, json=dump(body))


def rates(body: Body, idempotency_key: str | None) -> Spec:
    payload = dump(body)
    live = payload.get("freshness") == "live"
    return Spec("POST", "/v2/rates", {200: model(m.RatesResponse), 202: model(m.Job)}, json=payload,
                idempotency_key=_idem(idempotency_key) if live else None)


def rates_batch(body: Body, idempotency_key: str | None) -> Spec:
    return Spec("POST", "/v2/rates/batch", {202: model(m.Job)}, json=dump(body), idempotency_key=_idem(idempotency_key))


def reconcile(body: Body, idempotency_key: str | None) -> Spec:
    return Spec("POST", "/v2/rooms/reconcile", {200: model(m.ReconcileResult), 202: model(m.Job)}, json=dump(body),
                idempotency_key=_idem(idempotency_key))


def booking_create(body: Body, idempotency_key: str | None) -> Spec:
    return Spec("POST", "/v2/bookings", {202: model(m.Booking), 200: model(m.Booking)}, json=dump(body),
                idempotency_key=_idem(idempotency_key))


def booking_get(booking_id: str) -> Spec:
    return Spec("GET", f"/v2/bookings/{booking_id}", {200: model(m.Booking)})


def booking_cancel(booking_id: str) -> Spec:
    return Spec("POST", f"/v2/bookings/{booking_id}/cancel", {200: model(m.Booking)})


def quote_create(body: Body, idempotency_key: str | None) -> Spec:
    return Spec("POST", "/v2/quotes", {202: model(m.Quote), 200: model(m.Quote)}, json=dump(body),
                idempotency_key=_idem(idempotency_key))


def quote_get(quote_id: str) -> Spec:
    return Spec("GET", f"/v2/quotes/{quote_id}", {200: model(m.Quote)})


def quote_cancel(quote_id: str) -> Spec:
    return Spec("POST", f"/v2/quotes/{quote_id}/cancel", {200: model(m.Quote)})


def quote_accept(quote_id: str, offer_id: str, body: Body, idempotency_key: str | None) -> Spec:
    return Spec("POST", f"/v2/quotes/{quote_id}/offers/{offer_id}/accept", {200: model(m.Quote)}, json=dump(body),
                idempotency_key=_idem(idempotency_key))


def job_get(job_id: str) -> Spec:
    return Spec("GET", f"/v2/jobs/{job_id}", {200: model(m.Job)})


def job_list(query: Mapping[str, Any] | None) -> Spec:
    return Spec("GET", "/v2/jobs", {200: model(m.JobList)}, params=clean_query(query))


def job_result(job_id: str) -> Spec:
    return Spec("GET", f"/v2/jobs/{job_id}/result", {}, raw=True,
                headers={"Accept": "application/x-ndjson, application/json"})


def job_download(job: m.Job, base_url: str) -> Spec:
    """``result_url`` when it is a signed link elsewhere, else ``GET /v2/jobs/{id}/result``."""
    url = job.result_url
    if not url or urlsplit(url)[:2] == urlsplit(base_url)[:2]:
        return job_result(job.job_id)
    return Spec("GET", url, {}, raw=True, anonymous=True)


def job_cancel(job_id: str) -> Spec:
    return Spec("POST", f"/v2/jobs/{job_id}/cancel", {200: model(m.Job)})


def webhook_create(body: Body) -> Spec:
    return Spec("POST", "/v2/webhooks", {201: model(m.WebhookCreated), 200: model(m.WebhookCreated)}, json=dump(body))


def webhook_list() -> Spec:
    return Spec("GET", "/v2/webhooks", {200: model(m.WebhookList)})


def webhook_delete(webhook_id: str) -> Spec:
    return Spec("DELETE", f"/v2/webhooks/{webhook_id}", {204: lambda _: None})


def webhook_deliveries(webhook_id: str, query: Mapping[str, Any] | None) -> Spec:
    return Spec("GET", f"/v2/webhooks/{webhook_id}/deliveries", {200: model(m.WebhookDeliveryList)},
                params=clean_query(query))


def chat(body: Body) -> Spec:
    return Spec("POST", "/v2/chat", {200: model(m.ChatResponse)}, json=dump(body))


def amenities() -> Spec:
    return Spec("GET", "/v2/amenities", {200: model(m.AmenityList)})


def engines() -> Spec:
    return Spec("GET", "/v2/engines", {200: model(m.EngineList)})


def health() -> Spec:
    return Spec("GET", "/v2/health", {200: model(m.Health)})


def openapi() -> Spec:
    return Spec("GET", "/v2/openapi.json", {200: dict})


def default_headers(api_key: str | None, extra: Mapping[str, str] | None) -> dict[str, str]:
    headers = {"Accept": "application/json", "User-Agent": f"vistalink-python/{__version__}",
               "X-VistaLink-Client": f"vistalink-python/{__version__}"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(extra or {})
    return headers


def request_headers(spec: Spec) -> dict[str, str]:
    h = dict(spec.headers)
    if spec.idempotency_key:
        h["Idempotency-Key"] = spec.idempotency_key
    return h
