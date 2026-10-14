from __future__ import annotations

import time
from typing import Any, Callable, Iterable, Iterator, Mapping

import httpx

from . import _base as b
from . import models as m
from . import webhooks as _webhooks
from ._errors import VistaLinkError
from ._retry import RETRY_STATUSES, RetryConfig, backoff_delay, parse_retry_after


class VistaLink:
    """Synchronous VistaLink API v2 client.

    >>> vl = VistaLink(api_key=os.environ["VISTALINK_API_KEY"])
    >>> vl.search.run({"query": "rooftop near the Pantheon"}).hotels
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = b.DEFAULT_BASE_URL,
        max_retries: int = 3,
        timeout: float = 60.0,
        headers: Mapping[str, str] | None = None,
        http_client: httpx.Client | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.openapi_url = f"{self.base_url}/v2/openapi.json"
        self._retry = RetryConfig(max_retries=max_retries)
        self._sleep = sleep
        self._owns_client = http_client is None
        self._http = http_client or httpx.Client(timeout=timeout)
        self._headers = b.default_headers(api_key, headers)
        self.hotels = Hotels(self)
        self.search = Search(self)
        self.rates = Rates(self)
        self.rooms = Rooms(self)
        self.bookings = Bookings(self)
        self.quotes = Quotes(self)
        self.jobs = Jobs(self)
        self.webhooks = Webhooks(self)
        self.chat = Chat(self)
        self.catalog = Catalog(self)

    def close(self) -> None:
        if self._owns_client:
            self._http.close()

    def __enter__(self) -> "VistaLink":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _send(self, spec: b.Spec) -> Any:
        headers = {**self._headers, **b.request_headers(spec)}
        if spec.anonymous:
            headers.pop("Authorization", None)
        url = spec.path if spec.anonymous else self.base_url + spec.path
        for attempt in range(self._retry.max_retries + 1):
            last = attempt >= self._retry.max_retries
            try:
                response = self._http.request(spec.method, url, json=spec.json, params=spec.params, headers=headers)
            except httpx.TimeoutException as exc:
                if spec.repeatable and not last:
                    self._sleep(backoff_delay(attempt, self._retry, None))
                    continue
                raise VistaLinkError("timeout", f"Request timed out: {exc}") from exc
            except httpx.TransportError as exc:
                if spec.repeatable and not last:
                    self._sleep(backoff_delay(attempt, self._retry, None))
                    continue
                raise VistaLinkError("network_error", f"Network error: {exc}") from exc
            if response.status_code in RETRY_STATUSES and not last:
                self._sleep(backoff_delay(attempt, self._retry, parse_retry_after(response.headers.get("retry-after"))))
                continue
            return b.parse_response(spec, response)
        raise AssertionError("unreachable")

    def _poll(self, get: Callable[[], Any], done: Callable[[Any], bool], *, timeout: float, interval: float,
              max_interval: float, on_poll: Callable[[Any], None] | None, what: str) -> Any:
        deadline = time.monotonic() + timeout
        while True:
            value = get()
            if on_poll:
                on_poll(value)
            if done(value):
                return value
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise VistaLinkError("timeout", f"Timed out after {timeout:g}s waiting for {what}")
            self._sleep(min(interval, remaining))
            interval = min(max_interval, interval * 1.5)


class _Resource:
    def __init__(self, client: VistaLink) -> None:
        self._c = client


class Hotels(_Resource):
    def resolve(self, body: b.Body) -> m.ResolveResponse:
        """``POST /v2/hotels/resolve`` (free)."""
        return self._c._send(b.resolve(body))

    def get(self, hotel_id: str, **query: Any) -> m.HotelDetailResponse:
        """``GET /v2/hotels/{hotel_id}``; keyword args are query params (``sections``, ``check_in``, ``search_id`` …)."""
        return self._c._send(b.hotel(hotel_id, query))


class Search(_Resource):
    def run(self, body: b.Body) -> m.SearchResponse:
        return self._c._send(b.search(body))

    def answer(self, search_id: str, answers: Iterable[Mapping[str, Any]]) -> m.SearchResponse:
        return self.run({"search_id": search_id, "answers": list(answers)})

    def pages(self, body: b.Body, *, max_pages: int | None = None) -> Iterator[m.SearchResponse]:
        payload = b.dump(body)
        page = self.run(payload)
        n = 1
        yield page
        while page.next_cursor and (max_pages is None or n < max_pages):
            page = self.run({**payload, "search_id": page.search_id or payload.get("search_id"), "cursor": page.next_cursor})
            n += 1
            yield page


class Rates(_Resource):
    def get(self, body: b.Body, *, idempotency_key: str | None = None) -> m.RatesResponse | m.Job:
        """``POST /v2/rates`` as sent: cached → RatesResponse (200), live → Job (202)."""
        return self._c._send(b.rates(body, idempotency_key))

    def cached(self, body: b.Body) -> m.RatesResponse:
        r = self.get({**b.dump(body), "freshness": "cached"})
        if isinstance(r, m.Job):
            raise VistaLinkError("invalid_response", "Expected cached rates, got a job", status=202)
        return r

    def live(self, body: b.Body, *, idempotency_key: str | None = None) -> m.Job:
        r = self.get({**b.dump(body), "freshness": "live"}, idempotency_key=idempotency_key)
        if not isinstance(r, m.Job):
            raise VistaLinkError("invalid_response", "Expected a job for live rates", status=200)
        return r

    def batch(self, body: b.Body, *, idempotency_key: str | None = None) -> m.Job:
        return self._c._send(b.rates_batch(body, idempotency_key))


class Rooms(_Resource):
    def reconcile(self, body: b.Body, *, idempotency_key: str | None = None) -> m.ReconcileResult | m.Job:
        return self._c._send(b.reconcile(body, idempotency_key))


class Bookings(_Resource):
    def create(self, body: b.Body, *, idempotency_key: str | None = None) -> m.Booking:
        """``POST /v2/bookings``; an Idempotency-Key is generated when not given.

        ``payment.mode`` is ``checkout`` (hosted checkout link), ``handoff`` (hosted guest session)
        or ``external`` (the engine's own prefilled page). ``booking_next_step()`` says what to show.
        """
        return self._c._send(b.booking_create(body, idempotency_key))

    def get(self, booking_id: str) -> m.Booking:
        return self._c._send(b.booking_get(booking_id))

    def cancel(self, booking_id: str) -> m.Booking:
        """Moves the booking to ``canceled`` (409 ``conflict`` once the engine submit has run)."""
        return self._c._send(b.booking_cancel(booking_id))

    def wait(self, booking_id: str, *, until: Iterable[str] = b.BOOKING_STOP_DEFAULT, timeout: float = 600,
             interval: float = 2.0, max_interval: float = 15.0,
             on_poll: Callable[[m.Booking], None] | None = None) -> m.Booking:
        stop = set(until)
        return self._c._poll(lambda: self.get(booking_id), lambda x: x.status in stop, timeout=timeout,
                             interval=interval, max_interval=max_interval, on_poll=on_poll, what=f"booking {booking_id}")


class Quotes(_Resource):
    def create(self, body: b.Body, *, idempotency_key: str | None = None) -> m.Quote:
        """``POST /v2/quotes``: VistaLink emails the hotel for a direct price, on behalf of a guest it
        does not name. An Idempotency-Key is generated when not given. Returns the open quote for the
        same hotel and stay instead of sending a second email. $0.25 per quote the hotel answers with
        a price; test keys get a simulated hotel (``sandbox_outcome``)."""
        return self._c._send(b.quote_create(body, idempotency_key))

    def get(self, quote_id: str) -> m.Quote:
        return self._c._send(b.quote_get(quote_id))

    def cancel(self, quote_id: str) -> m.Quote:
        """Stops further emails to the hotel. Free; cancelled after a priced offer keeps the charge."""
        return self._c._send(b.quote_cancel(quote_id))

    def accept(self, quote_id: str, offer_id: str, body: b.Body, *, idempotency_key: str | None = None) -> m.Quote:
        """Send the hotel ONE introduction email with the guest copied; it can't be taken back. Free.
        An Idempotency-Key is generated when not given, so a retry never introduces the guest twice."""
        return self._c._send(b.quote_accept(quote_id, offer_id, body, idempotency_key))

    def wait(self, quote_id: str, *, until: Iterable[str] = b.QUOTE_STOP_DEFAULT, timeout: float = 600,
             interval: float = 2.0, max_interval: float = 60.0,
             on_poll: Callable[[m.Quote], None] | None = None) -> m.Quote:
        """Poll until the quote has an offer or closes. Hotels usually reply within hours: raise
        ``timeout`` (or subscribe to ``quote.updated``) for live keys."""
        stop = set(until)
        return self._c._poll(lambda: self.get(quote_id), lambda x: x.status in stop, timeout=timeout,
                             interval=interval, max_interval=max_interval, on_poll=on_poll, what=f"quote {quote_id}")


class Jobs(_Resource):
    def get(self, job_id: str) -> m.Job:
        return self._c._send(b.job_get(job_id))

    def list(self, **query: Any) -> m.JobList:
        return self._c._send(b.job_list(query))

    def list_all(self, **query: Any) -> Iterator[m.Job]:
        cursor = None
        while True:
            page = self.list(**query, cursor=cursor)
            yield from page.jobs
            if not page.next_cursor:
                return
            cursor = page.next_cursor

    def cancel(self, job_id: str) -> m.Job:
        return self._c._send(b.job_cancel(job_id))

    def result(self, job_id: str) -> str:
        """``GET /v2/jobs/{id}/result``: the raw NDJSON of a finished ``rates.batch`` job (free)."""
        return self._c._send(b.job_result(job_id))

    def download(self, job: m.Job) -> str:
        """The NDJSON result: from a signed ``result_url`` (no API key sent), else ``GET /v2/jobs/{id}/result``."""
        return self._c._send(b.job_download(job, self._c.base_url))

    def wait_for_result(self, job_id: str, *, timeout: float = 600, interval: float = 2.0,
                        max_interval: float = 15.0, on_poll: Callable[[m.Job], None] | None = None) -> tuple[m.Job, str]:
        """``wait`` then ``download``: ``(job, ndjson)``. ``parse_ndjson()`` splits the lines."""
        job = self.wait(job_id, timeout=timeout, interval=interval, max_interval=max_interval, on_poll=on_poll)
        return job, self.download(job)

    def wait(self, job_id: str, *, timeout: float = 600, interval: float = 2.0, max_interval: float = 15.0,
             on_poll: Callable[[m.Job], None] | None = None, raise_on_failure: bool = True) -> m.Job:
        """Poll until ``succeeded | failed | canceled``."""
        job = self._c._poll(lambda: self.get(job_id), lambda j: j.status in b.JOB_TERMINAL, timeout=timeout,
                            interval=interval, max_interval=max_interval, on_poll=on_poll, what=f"job {job_id}")
        if raise_on_failure and job.status != "succeeded":
            raise b.job_failure(job)
        return job


class Webhooks(_Resource):
    def create(self, body: b.Body) -> m.WebhookCreated:
        return self._c._send(b.webhook_create(body))

    def list(self) -> m.WebhookList:
        return self._c._send(b.webhook_list())

    def delete(self, webhook_id: str) -> None:
        """``DELETE /v2/webhooks/{id}`` (204, no body)."""
        self._c._send(b.webhook_delete(webhook_id))

    def deliveries(self, webhook_id: str, **query: Any) -> m.WebhookDeliveryList:
        return self._c._send(b.webhook_deliveries(webhook_id, query))

    @staticmethod
    def verify(secret: str, headers: Mapping[str, Any] | str, raw_body: bytes | str, *,
               tolerance: int = _webhooks.DEFAULT_TOLERANCE_SECONDS, now: int | None = None) -> dict[str, Any]:
        return _webhooks.verify(secret, headers, raw_body, tolerance=tolerance, now=now)


class Chat(_Resource):
    def send(self, body: b.Body) -> m.ChatResponse:
        return self._c._send(b.chat(body))


class Catalog(_Resource):
    def amenities(self) -> m.AmenityList:
        return self._c._send(b.amenities())

    def engines(self) -> m.EngineList:
        return self._c._send(b.engines())

    def health(self) -> m.Health:
        return self._c._send(b.health())

    def openapi(self) -> dict[str, Any]:
        """``GET /v2/openapi.json`` (public)."""
        return self._c._send(b.openapi())
