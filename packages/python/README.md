# vistalink (Python)

> 0.0.x reserves the name; the first working release is 2.0.0, tracking API v2.

Python client for the VistaLink hotel API v2: a thin sync + async client on
`httpx`, with pydantic v2 models generated from `spec/openapi.v2.json`.


```bash
pip install vistalink
```

```python
import os
from vistalink import VistaLink, AsyncVistaLink, VistaLinkError, booking_next_step, parse_ndjson

vl = VistaLink(api_key=os.environ["VISTALINK_API_KEY"])   # base_url defaults to https://api.vistalink.com
```

**Models:** generated with `datamodel-code-generator`, chosen because it emits
plain pydantic v2 models and nothing else, which suits a hand-written thin
client better than `openapi-python-client`'s full generated client with attrs
models. Request bodies accept either a dict or a model
(`vistalink.models.SearchRequest(...)`). Responses are always parsed into
models (`SearchResponse`, `Job`, `Booking`, …). Unknown fields are kept
(`extra="allow"`).

What the client does for you, same as the TypeScript SDK:

- `Authorization: Bearer <key>` on every call.
- `Idempotency-Key` generated for `bookings.create`, `rates.batch`,
  `rooms.reconcile` and live `rates`. Pass `idempotency_key=` to set it
  yourself. Retries reuse the same key.
- Retries 429 (honouring `Retry-After`) and 503 with jittered exponential
  backoff (`max_retries=3`). Network errors are retried only for GET/DELETE
  and POSTs that carry an idempotency key.
- Raises `VistaLinkError(code, message, status, request_id, details)` for
  every non-2xx. Client-side codes are `network_error`, `timeout`,
  `job_failed` and `job_canceled`.
- `jobs.wait()` / `bookings.wait()`, `jobs.download()` /
  `jobs.wait_for_result()` for `rates.batch` NDJSON (signed `result_url`, else
  `GET /v2/jobs/{id}/result`), `booking_next_step()`, `jobs.list_all()` /
  `search.pages()`, and `webhooks.verify()`.

## 1. Resolve identifiers (free)

```python
res = vl.hotels.resolve({"identifiers": [
    {"booking_url": "https://www.booking.com/hotel/it/umilta-36.en-gb.html"},
    {"website_url": "https://umilta36.com"},
    {"name": "Umiltà 36", "city": "Rome", "country": "IT"},
]})
for r in res.results:
    print(r.input, r.status, r.hotel_id, r.match)
```

## 2. Search, the 2×2

```python
# structured + filters ($0.003)
structured = vl.search.run({
    "filters": {
        "location": {"city": "Rome", "country": "IT"},
        "stay": {"check_in": "2026-11-14", "check_out": "2026-11-16", "rooms": [{"adults": 2}]},
        "budget": {"max": "400", "currency": "EUR"},
        "min_stars": 4,
        "amenities": ["SPA"],
    },
    "ranking": "filters",
})

# loose + semantic ($0.012)
loose = vl.search.run({
    "query": "quiet place near the Colosseum with a rooftop, under 400 a night",
    "ranking": "semantic",
    "limit": 10,
})
if loose.status == "needs_clarification":
    q = loose.clarifications[0]
    loose = vl.search.answer(loose.search_id, [{"clarification_id": q.id, "option_id": q.options[0].id}])
# query + "filters" = loose.filters ($0.005); filters only + "semantic" = structured.semantic ($0.008)
```

## 3. Hotel detail with the search's `search_id`

```python
top = loose.hotels[0]
hotel = vl.hotels.get(
    top.hotel_id,
    search_id=loose.search_id,          # warmed cache, same price
    sections="core,images,rooms,rates",
    check_in="2026-11-14", check_out="2026-11-16", adults=2,
)
print(hotel.core.name, len(hotel.rooms or []))
```

## 4. Cached rates, then a live job

```python
stay = {"check_in": "2026-11-14", "check_out": "2026-11-16", "rooms": [{"adults": 2}]}

cached = vl.rates.cached({"hotels": [top.hotel_id], "stay": stay, "max_age_hours": 24})
print(cached.summary, cached.results[0].status)

job = vl.rates.live({"hotels": [top.hotel_id], "stay": stay})        # 202 + Idempotency-Key
done = vl.jobs.wait(job.job_id, timeout=120, on_poll=lambda j: print(j.status, j.progress))
print(done.result)                                                    # same shape as the cached response
```

### Batch rates: the NDJSON result

```python
job = vl.rates.batch({"hotels": ids, "stays": [stay]})
job, ndjson = vl.jobs.wait_for_result(job.job_id, timeout=1800)
for row in parse_ndjson(ndjson):
    print(row["hotel_id"], row["status"])
# jobs.download(job) alone: a signed result_url is fetched without the key;
# when result_url is None it is GET /v2/jobs/{id}/result with the key (free).
```

## 5. Booking (the guest always pays the property)

```python
offer_id = cached.results[0].rooms[0].offers[0].offer_id
booking = vl.bookings.create(
    {
        "hotel_id": top.hotel_id,
        "offer_id": offer_id,
        "stay": stay,
        "guests": [{"room": 0, "lead": {"first_name": "Ada", "last_name": "Rossi", "email": "ada@example.com"}}],
        "payment": {"mode": "checkout", "return_url": "https://partner.example/booking/done", "locale": "en"},
    },
    idempotency_key=f"booking-{order_id}",    # reuse on retry; omitted, one is generated
)
ready = vl.bookings.wait(booking.booking_id)           # stops when the guest has to act, or final
step = booking_next_step(ready)
if step.url:
    show_link(step.url)   # checkout: payment.checkout_url; handoff / external: handoff.url
final = vl.bookings.wait(booking.booking_id, until=["confirmed", "confirmation_pending", "failed", "expired", "canceled"])
if final.status == "failed":
    print(final.failure.reason)                         # e.g. payment_unavailable
```

`payment.mode` (`PAYMENT_MODES`) is `checkout` (stops at `requires_payment`,
`payment.checkout_url`), `handoff` (stops at `requires_user_action`, hosted
session at `handoff.url`) or `external` (stops at `requires_user_action`, the
engine's own prefilled page at `handoff.url`). `bookings.cancel(id)` moves a
booking to `canceled`. `webhooks.delete(id)` returns `None` (204).

## 6. Quotes (ask the hotel for a direct price)

```python
quote = vl.quotes.create({
    "hotel_id": "43d0be71-5f3c-4c8e-9a52-1d7e2b6f0a19",
    "stay": {"check_in": "2026-11-27", "check_out": "2026-11-30", "rooms": [{"adults": 2, "children_ages": []}]},
    "wants": {"refundable": True, "room_type": "double"},
})                                                     # VistaLink emails the hotel; Idempotency-Key generated
ready = vl.quotes.wait(quote.quote_id, timeout=6 * 3600)  # first offer, or the quote closing
if ready.status == "offer_received":
    vl.quotes.accept(quote.quote_id, ready.offers[0].offer_id,
                     {"guest": {"first_name": "Ada", "last_name": "Rossi", "email": "ada@example.com"}})
```

$0.25 per quote the hotel answers with a price; accept and cancel are free.
Test keys get a simulated hotel within seconds (`sandbox_outcome`).

## Async

```python
async with AsyncVistaLink(api_key=os.environ["VISTALINK_API_KEY"]) as vl:
    res = await vl.search.run({"query": "rooftop near the Pantheon"})
    job = await vl.rates.live({"hotels": [res.hotels[0].hotel_id], "stay": stay})
    done = await vl.jobs.wait(job.job_id)
    async for j in vl.jobs.list_all(kind="rates.live"):
        ...
```

## Errors

```python
try:
    vl.rates.cached({"hotels": ["…"], "stay": stay, "channel": "third_party"})
except VistaLinkError as e:
    print(e.status, e.code, e.message, e.request_id, e.details)
```

## Webhooks

```python
from vistalink import webhooks, WebhookVerificationError

@app.post("/hooks")                      # Flask: request.get_data(); FastAPI: await request.body()
def hook():
    try:
        event = webhooks.verify(os.environ["VISTALINK_WEBHOOK_SECRET"], request.headers, request.get_data())
    except WebhookVerificationError:
        return "", 400
    ...
```

The tolerance is 5 minutes (`tolerance=300`). Pass the raw body, not
re-serialised JSON.

## Development

```bash
uv venv .venv && uv pip install -e '.[dev]'
./scripts/generate.sh     # models.py + _async_client.py from ../../spec/openapi.v2.json
.venv/bin/pytest          # respx-mocked tests, sync + async
```
