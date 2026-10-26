# @vistalink/api

> 0.0.x reserves the name; the first working release is 2.0.0, tracking API v2.

TypeScript client for the VistaLink hotel API v2. Types are generated from
`spec/openapi.v2.json` with `openapi-typescript`; requests go through
`openapi-fetch`. ESM + CJS, Node 20+, browsers and edge runtimes (no Node
built-ins; webhook verification uses WebCrypto).


```bash
npm install @vistalink/api
```

```ts
import { VistaLink, VistaLinkError, bookingNextStep, isJob, parseNdjson } from "@vistalink/api";

const vl = new VistaLink({ apiKey: process.env.VISTALINK_API_KEY });
// baseUrl defaults to https://api.vistalink.com
```

What the client does for you:

- `Authorization: Bearer <key>` on every call.
- `Idempotency-Key` generated for every POST that creates a job or a booking
  (`/v2/bookings`, `/v2/rates/batch`, `/v2/rooms/reconcile`, `/v2/rates` with
  `freshness: "live"`). Pass `{ idempotencyKey }` to choose it; retries resend
  the same key.
- Retries 429 (honouring `Retry-After`) and 503 with jittered exponential
  backoff (default 3 retries). Network errors are retried only for GET/DELETE
  and idempotency-keyed POSTs.
- Throws `VistaLinkError { code, message, requestId, status, details }` for
  every non-2xx (`code` is the API's `error.code`), plus client-side codes
  `network_error`, `timeout`, `job_failed`, `job_canceled`.
- `jobs.wait()` / `bookings.wait()` polling, `jobs.download()` /
  `jobs.waitForResult()` for buffered `rates.batch` NDJSON, plus
  `jobs.downloadStream()` / `jobs.resultStream()` for raw byte streaming (signed `result_url`, else
  `GET /v2/jobs/{id}/result`), `bookingNextStep()`, `jobs.listAll()` /
  `search.pages()` cursor pagination, `webhooks.verify()`.
- `vl.raw` is the typed openapi-fetch client for anything else.

## 1. Resolve identifiers to hotel ids (free)

```ts
const { results } = await vl.hotels.resolve({
  identifiers: [
    { booking_url: "https://www.booking.com/hotel/it/umilta-36.en-gb.html" },
    { website_url: "https://umilta36.com" },
    { name: "Umiltà 36", city: "Rome", country: "IT" },
  ],
});
for (const r of results) console.log(r.input, r.status, r.hotel_id, r.match);
```

## 2. Search — the 2×2 (structured/loose × filters/semantic)

```ts
// Structured + filters ($0.003): no free text, deterministic filtering.
const structured = await vl.search.run({
  filters: {
    location: { city: "Rome", country: "IT" },
    stay: { check_in: "2026-11-14", check_out: "2026-11-16", rooms: [{ adults: 2 }] },
    budget: { max: "400", currency: "EUR" },
    min_stars: 4,
    amenities: ["SPA"],
  },
  ranking: "filters",
});

// Loose + semantic ($0.012): free text, ranked on review/image evidence.
const loose = await vl.search.run({
  query: "quiet place near the Colosseum with a rooftop, under 400 a night",
  ranking: "semantic",
  limit: 10,
});

if (loose.status === "needs_clarification") {
  const q = loose.clarifications![0];
  await vl.search.answer(loose.search_id!, [{ clarification_id: q.id, option_id: q.options![0].id }]);
}
// The other two quadrants: `query` + `ranking: "filters"` (loose.filters, $0.005),
// filters only + `ranking: "semantic"` (structured.semantic, $0.008).
```

## 3. Hotel detail, reusing the search's warm cache

```ts
const top = loose.hotels![0];
const hotel = await vl.hotels.get(top.hotel_id, {
  search_id: loose.search_id!,          // same price, cache hit
  sections: "core,images,rooms,rates",
  check_in: "2026-11-14",
  check_out: "2026-11-16",
  adults: 2,
});
console.log(hotel.core?.name, hotel.rooms?.length, hotel.rates?.channels);
```

## 4. Cached rates, then a live refresh job

```ts
const stay = { check_in: "2026-11-14", check_out: "2026-11-16", rooms: [{ adults: 2 }] };

const cached = await vl.rates.cached({ hotels: [top.hotel_id], stay, max_age_hours: 24 });
console.log(cached.summary, cached.results[0]?.status);

const job = await vl.rates.live({ hotels: [top.hotel_id], stay });   // 202, Idempotency-Key set
const done = await vl.jobs.wait(job.job_id, {
  timeoutMs: 120_000,
  onPoll: (j) => console.log(j.status, j.progress),
});
console.log(done.result);   // same shape as the cached response
```

### Batch rates: the NDJSON result

```ts
const job = await vl.rates.batch({ hotels: ids, stays: [stay] });
const { ndjson } = await vl.jobs.waitForResult(job.job_id, { timeoutMs: 30 * 60_000 });
for (const row of parseNdjson(ndjson)) console.log(row.hotel_id, row.status);
// jobs.download(job) alone: a signed result_url is fetched without the key;
// when result_url is null it is GET /v2/jobs/{id}/result with the key (free).

// Large results can be consumed without building one large string in memory.
import { pipeline } from "node:stream/promises";
const stream = await vl.jobs.downloadStream(job);
await pipeline(stream, process.stdout); // Node applies backpressure and propagates output errors.
```

`timeoutMs` bounds each fetch attempt through the response headers; it does not set a
deadline for reading the stream body. Pass `{ signal }` to `downloadStream()` or
`resultStream()` to cancel body consumption after the response begins.

## 5. Booking (the guest always pays the property)

```ts
const offerId = cached.results[0].rooms![0].offers![0].offer_id;

const booking = await vl.bookings.create(
  {
    hotel_id: top.hotel_id,
    offer_id: offerId,
    stay,
    guests: [{ room: 0, lead: { first_name: "Ada", last_name: "Rossi", email: "ada@example.com" } }],
    payment: { mode: "checkout", return_url: "https://partner.example/booking/done", locale: "en" },
  },
  { idempotencyKey: `booking-${orderId}` },    // reuse on retry; omitted → generated
);

const ready = await vl.bookings.wait(booking.booking_id);   // stops when the guest has to act, or final
const next = bookingNextStep(ready);
if (next.url) showLink(next.url);   // checkout → payment.checkout_url; handoff / external → handoff.url
const final = await vl.bookings.wait(booking.booking_id, { until: ["confirmed", "confirmation_pending", "failed", "expired", "canceled"] });
if (final.status === "failed") console.log(final.failure?.reason);   // e.g. payment_unavailable
```

`payment.mode` is one of:

| mode | the booking stops at | send the guest to |
|---|---|---|
| `checkout` | `requires_payment` | `payment.checkout_url` (hosted checkout; the property is paid) |
| `handoff` | `requires_user_action` | `handoff.url` (hosted guest session) |
| `external` | `requires_user_action` | `handoff.url` (the engine's own prefilled page) |

`bookings.cancel(id)` moves a booking to `canceled` while it is `queued`,
`requires_payment` or `requires_user_action` (or `processing` before the engine
submit). After that it answers 409 `conflict`. `webhooks.delete(id)` resolves
to `undefined` (204).

## Quotes (ask the hotel for a direct price)

```ts
const quote = await vl.quotes.create({
  hotel_id: "43d0be71-5f3c-4c8e-9a52-1d7e2b6f0a19",
  stay: { check_in: "2026-11-27", check_out: "2026-11-30", rooms: [{ adults: 2, children_ages: [] }] },
  wants: { refundable: true, room_type: "double" },
});                                                   // VistaLink emails the hotel; Idempotency-Key generated
const ready = await vl.quotes.wait(quote.quote_id, { timeoutMs: 6 * 3_600_000 }); // first offer, or closed
if (ready.status === "offer_received") {
  const offer = ready.offers[0];                      // total, board, free_cancellation, beats_by, evidence…
  await vl.quotes.accept(quote.quote_id, offer.offer_id, {
    guest: { first_name: "Ada", last_name: "Rossi", email: "ada@example.com" },
  });                                                 // ONE intro email to the hotel, guest copied
}
```

$0.25 per quote the hotel answers with a price; accept and cancel are free.
Test keys get a simulated hotel within seconds (`sandbox_outcome`). For live
keys, prefer the `quote.updated` webhook to a long `wait`.

## Errors

```ts
try {
  await vl.rates.cached({ hotels: ["…"], stay, channel: "third_party" });
} catch (e) {
  if (e instanceof VistaLinkError) console.error(e.status, e.code, e.message, e.requestId, e.details);
}
```

## Webhooks

```ts
// Express: app.post("/hooks", express.raw({ type: "application/json" }), …)
const event = await vl.webhooks.verify(process.env.VISTALINK_WEBHOOK_SECRET!, req.headers, req.body);
// throws WebhookVerificationError on a bad/missing signature or a timestamp > 5 min off
if (event.event === "booking.updated") { /* … */ }
```

`verifyWebhook(secret, headers, rawBody, { toleranceSeconds })` is also
exported standalone; it needs the raw bytes, not re-serialised JSON.

## Development

```bash
pnpm run generate   # src/generated/schema.ts from ../../spec/openapi.v2.json
pnpm test           # vitest, mocked fetch
pnpm build          # tsup → dist/ (ESM + CJS + d.ts)
```
