import { describe, expect, it, vi } from "vitest";
import { VistaLink, VistaLinkError, bookingNextStep, isJob, parseNdjson, type Booking } from "../src/index.js";
import { JOB, mockFetch, noSleep } from "./helpers.js";

const make = (replies: Parameters<typeof mockFetch>[0], extra: Record<string, unknown> = {}) => {
  const m = mockFetch(replies);
  const sleeps: number[] = [];
  const vl = new VistaLink({
    apiKey: "vl_test_abc",
    baseUrl: "https://api.test",
    fetch: m.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });
  return { vl, calls: m.calls, sleeps };
};

describe("auth", () => {
  it("sends the bearer key and client header", async () => {
    const { vl, calls } = make([{ status: 200, body: { request_id: "req_1", billing: null, results: [] } }]);
    await vl.hotels.resolve({ identifiers: [{ name: "Umiltà 36", city: "Rome" }] });
    expect(calls[0].headers.get("authorization")).toBe("Bearer vl_test_abc");
    expect(calls[0].headers.get("x-vistalink-client")).toMatch(/^vistalink-ts\//);
    expect(calls[0].url).toBe("https://api.test/v2/hotels/resolve");
    expect(calls[0].method).toBe("POST");
  });

  it("omits Authorization when no key is given", async () => {
    const m = mockFetch([{ status: 200, body: { status: "ok" } }]);
    const vl = new VistaLink({ baseUrl: "https://api.test", fetch: m.fetch });
    await vl.catalog.health();
    expect(m.calls[0].headers.has("authorization")).toBe(false);
  });

  it("builds path and query params", async () => {
    const { vl, calls } = make([{ status: 200, body: { request_id: "r", hotel_id: "h1" } }]);
    await vl.hotels.get("h1", { sections: "core,rooms", check_in: "2026-11-14", check_out: "2026-11-16", search_id: "srch_1" });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe("/v2/hotels/h1");
    expect(u.searchParams.get("sections")).toBe("core,rooms");
    expect(u.searchParams.get("search_id")).toBe("srch_1");
  });
});

describe("retries", () => {
  it("retries 429 honouring Retry-After seconds", async () => {
    const { vl, calls, sleeps } = make([
      { status: 429, body: { error: { code: "rate_limited", message: "slow down", request_id: "req_a" } }, headers: { "Retry-After": "2" } },
      { status: 200, body: { request_id: "req_b", amenities: [] } },
    ]);
    const r = await vl.catalog.amenities();
    expect(r.request_id).toBe("req_b");
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("retries 503 with exponential backoff and resends the same body", async () => {
    const { vl, calls, sleeps } = make([
      { status: 503, body: { error: { code: "unavailable", message: "x" } } },
      { status: 503, body: { error: { code: "unavailable", message: "x" } } },
      { status: 200, body: { request_id: "r", search_id: "s", status: "completed", hotels: [] } },
    ]);
    await vl.search.run({ query: "rome", limit: 5 });
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.body)).toEqual([{ query: "rome", limit: 5 }, { query: "rome", limit: 5 }, { query: "rome", limit: 5 }]);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
    expect(sleeps[1]).toBeGreaterThanOrEqual(500);
    expect(sleeps[1]).toBeLessThanOrEqual(1000);
  });

  it("gives up after maxRetries and throws the mapped error", async () => {
    const { vl, calls } = make(
      [{ status: 429, body: { error: { code: "rate_limited", message: "slow", request_id: "req_z" } }, headers: { "Retry-After": "1" } }],
      { maxRetries: 2 },
    );
    const err = await vl.catalog.engines().catch((e) => e);
    expect(err).toBeInstanceOf(VistaLinkError);
    expect(err.code).toBe("rate_limited");
    expect(err.requestId).toBe("req_z");
    expect(err.retryAfterSeconds).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it("does not retry other 4xx/5xx", async () => {
    const { vl, calls } = make([{ status: 502, body: { error: { code: "upstream_error", message: "engine down" } } }]);
    await expect(vl.catalog.engines()).rejects.toMatchObject({ code: "upstream_error", status: 502 });
    expect(calls).toHaveLength(1);
  });

  it("retries network errors only when the request is repeatable", async () => {
    const a = make([new TypeError("fetch failed"), { status: 200, body: { request_id: "r", jobs: [] } }]);
    await a.vl.jobs.list();
    expect(a.calls).toHaveLength(2);

    const b = make([new TypeError("fetch failed"), { status: 200, body: {} }]);
    const err = await b.vl.search.run({ query: "x" }).catch((e) => e);
    expect(err).toMatchObject({ code: "network_error", status: 0 });
    expect(b.calls).toHaveLength(1);
  });
});

describe("idempotency", () => {
  it("generates an Idempotency-Key for bookings and reuses it on retry", async () => {
    const booking = { booking_id: "bk_1", status: "queued", hotel_id: "h" };
    const { vl, calls } = make([
      { status: 503, body: { error: { code: "unavailable", message: "x" } } },
      { status: 202, body: booking },
    ]);
    const r = await vl.bookings.create({
      hotel_id: "h",
      offer_id: "off_1",
      stay: { check_in: "2026-11-14", check_out: "2026-11-16" },
      guests: [{ room: 0, lead: { first_name: "Ada", last_name: "Rossi", email: "ada@example.com", phone: "+390600000000" } }],
      payment: { mode: "checkout" },
    });
    expect(r.booking_id).toBe("bk_1");
    const k1 = calls[0].headers.get("idempotency-key");
    expect(k1).toMatch(/^[0-9a-f-]{32,36}$/);
    expect(calls[1].headers.get("idempotency-key")).toBe(k1);
  });

  it("sends the key as the declared header parameter on every keyed POST", async () => {
    const { vl, calls } = make([{ status: 202, body: JOB("queued", { kind: "rooms.reconcile" }) }]);
    await vl.rooms.reconcile(
      { hotel_id: "h1", sources: [{ kind: "booking_url", url: "https://www.booking.com/hotel/it/x.html" }] },
      { idempotencyKey: "rk-1", headers: { "X-Trace": "t" } },
    );
    expect(calls[0].headers.get("idempotency-key")).toBe("rk-1");
    expect(calls[0].headers.get("x-trace")).toBe("t");
  });

  it("uses the caller's key when given", async () => {
    const { vl, calls } = make([{ status: 202, body: JOB("queued", { kind: "rates.batch" }) }]);
    await vl.rates.batch({ hotels: ["h1"], stays: [{ check_in: "2026-11-14", check_out: "2026-11-16" }] }, { idempotencyKey: "my-key-1" });
    expect(calls[0].headers.get("idempotency-key")).toBe("my-key-1");
  });

  it("sets a key on live rates and reconcile, not on cached rates or search", async () => {
    const { vl, calls } = make([
      { status: 202, body: JOB("queued") },
      { status: 200, body: { request_id: "r", results: [] } },
      { status: 202, body: JOB("queued", { kind: "rooms.reconcile" }) },
      { status: 200, body: { request_id: "r", hotels: [] } },
    ]);
    const stay = { check_in: "2026-11-14", check_out: "2026-11-16" };
    const job = await vl.rates.live({ hotels: ["h1"], stay });
    expect(isJob(job)).toBe(true);
    await vl.rates.cached({ hotels: ["h1"], stay });
    await vl.rooms.reconcile({ hotel_id: "h1", sources: [{ kind: "booking_url", url: "https://www.booking.com/hotel/it/x.html" }] });
    await vl.search.run({ query: "x" });
    expect(calls[0].body).toMatchObject({ freshness: "live" });
    expect(calls[0].headers.has("idempotency-key")).toBe(true);
    expect(calls[1].body).toMatchObject({ freshness: "cached" });
    expect(calls[1].headers.has("idempotency-key")).toBe(false);
    expect(calls[2].headers.has("idempotency-key")).toBe(true);
    expect(calls[3].headers.has("idempotency-key")).toBe(false);
  });
});

describe("errors", () => {
  it("maps the v2 envelope", async () => {
    const { vl } = make([
      {
        status: 403,
        body: { error: { code: "forbidden", message: "third-party channel", request_id: "req_9", details: { reason: "enterprise_only" } } },
      },
    ]);
    const err = await vl.rates.cached({ hotels: ["h"], stay: { check_in: "2026-11-14", check_out: "2026-11-15" }, channel: "third_party" }).catch((e) => e);
    expect(err).toBeInstanceOf(VistaLinkError);
    expect(err).toMatchObject({ code: "forbidden", status: 403, requestId: "req_9", details: { reason: "enterprise_only" } });
    expect(err.message).toBe("third-party channel");
  });

  it("falls back to X-Request-Id and status codes for non-envelope bodies", async () => {
    const { vl } = make([{ status: 402, body: "nope", headers: { "X-Request-Id": "req_h" } }]);
    const err = await vl.catalog.engines().catch((e) => e);
    expect(err).toMatchObject({ code: "insufficient_credit", status: 402, requestId: "req_h" });
  });

  it("maps FastAPI 422 to bad_request with details.fields", async () => {
    const { vl } = make([{ status: 422, body: { detail: [{ loc: ["body", "limit"], msg: "too big", type: "x" }] } }]);
    const err = await vl.search.run({ limit: 999 }).catch((e) => e);
    expect(err.code).toBe("bad_request");
    expect(err.details.fields[0].loc).toEqual(["body", "limit"]);
  });
});

describe("empty bodies", () => {
  it("webhooks.delete accepts the 204 with no body", async () => {
    const { vl, calls } = make([{ status: 204 }]);
    await expect(vl.webhooks.delete("wh_1")).resolves.toBeUndefined();
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "https://api.test/v2/webhooks/wh_1" });
  });
});

describe("waiting", () => {
  it("jobs.wait polls until a terminal state", async () => {
    const { vl, calls, sleeps } = make([
      { status: 200, body: JOB("queued") },
      { status: 200, body: JOB("running") },
      { status: 200, body: JOB("succeeded", { result: { results: [] } }) },
    ]);
    const seen: string[] = [];
    const job = await vl.jobs.wait("job_1", { intervalMs: 100, onPoll: (j) => seen.push(j.status) });
    expect(job.status).toBe("succeeded");
    expect(seen).toEqual(["queued", "running", "succeeded"]);
    expect(calls.every((c) => c.url.endsWith("/v2/jobs/job_1"))).toBe(true);
    expect(sleeps).toEqual([100, 150]);
  });

  it("jobs.wait throws job_failed with the job error, unless told not to", async () => {
    const failed = JOB("failed", { error: { code: "upstream_error", message: "engine timeout" } });
    const a = make([{ status: 200, body: failed }]);
    await expect(a.vl.jobs.wait("job_1")).rejects.toMatchObject({ code: "job_failed", message: "engine timeout" });
    const b = make([{ status: 200, body: failed }]);
    await expect(b.vl.jobs.wait("job_1", { throwOnFailure: false })).resolves.toMatchObject({ status: "failed" });
  });

  it("jobs.wait times out", async () => {
    vi.useFakeTimers();
    try {
      const m = mockFetch([{ status: 200, body: JOB("running") }]);
      const vl = new VistaLink({
        apiKey: "k",
        baseUrl: "https://api.test",
        fetch: m.fetch,
        sleep: async (ms) => void vi.advanceTimersByTime(ms),
      });
      await expect(vl.jobs.wait("job_1", { timeoutMs: 1000, intervalMs: 400 })).rejects.toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bookings.wait stops at requires_payment", async () => {
    const b = (status: string, extra = {}) => ({ booking_id: "bk_1", status, hotel_id: "h", ...extra });
    const { vl } = make([
      { status: 200, body: b("queued") },
      { status: 200, body: b("requires_payment", { payment: { mode: "checkout", status: "pending", checkout_url: "https://checkout.stripe.com/c/pay/cs_1", payee: "property" } }) },
    ]);
    const r = await vl.bookings.wait("bk_1", { intervalMs: 1 });
    expect(r.status).toBe("requires_payment");
    expect(r.payment?.checkout_url).toContain("checkout.stripe.com");
  });
});

describe("job results", () => {
  const NDJSON = '{"hotel_id":"h1","status":"observed"}\n{"hotel_id":"h2","status":"unavailable"}\n';

  it("jobs.download uses GET /v2/jobs/{id}/result when result_url is null", async () => {
    const { vl, calls } = make([{ status: 200, text: NDJSON }]);
    const text = await vl.jobs.download({ job_id: "job_1", result_url: null });
    expect(text).toBe(NDJSON);
    expect(calls[0].url).toBe("https://api.test/v2/jobs/job_1/result");
    expect(calls[0].headers.get("authorization")).toBe("Bearer vl_test_abc");
    expect(parseNdjson(text)).toEqual([{ hotel_id: "h1", status: "observed" }, { hotel_id: "h2", status: "unavailable" }]);
  });

  it("jobs.download fetches a signed result_url without the API key", async () => {
    const { vl, calls } = make([{ status: 200, text: NDJSON }]);
    await vl.jobs.download({ job_id: "job_1", result_url: "https://files.test/r.ndjson?sig=abc" });
    expect(calls[0].url).toBe("https://files.test/r.ndjson?sig=abc");
    expect(calls[0].headers.has("authorization")).toBe(false);
  });

  it("jobs.download keeps the key when result_url points back at the API", async () => {
    const { vl, calls } = make([{ status: 200, text: NDJSON }]);
    await vl.jobs.download({ job_id: "job_1", result_url: "https://api.test/v2/jobs/job_1/result" });
    expect(calls[0].url).toBe("https://api.test/v2/jobs/job_1/result");
    expect(calls[0].headers.get("authorization")).toBe("Bearer vl_test_abc");
  });

  it("jobs.waitForResult waits, then downloads", async () => {
    const { vl, calls } = make([
      { status: 200, body: JOB("running", { kind: "rates.batch" }) },
      { status: 200, body: JOB("succeeded", { kind: "rates.batch", result_url: null }) },
      { status: 200, text: NDJSON },
    ]);
    const { job, ndjson } = await vl.jobs.waitForResult("job_1", { intervalMs: 1 });
    expect(job.status).toBe("succeeded");
    expect(ndjson).toBe(NDJSON);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v2/jobs/job_1", "/v2/jobs/job_1", "/v2/jobs/job_1/result"]);
  });
});

describe("bookings", () => {
  const b = (status: Booking["status"], extra: Partial<Booking> = {}): Booking => ({ booking_id: "bk_1", status, hotel_id: "h", ...extra });

  it("bookingNextStep covers the three payment modes and the final states", () => {
    expect(bookingNextStep(b("requires_payment", { payment: { mode: "checkout", status: "pending", checkout_url: "https://checkout.stripe.com/c/pay/cs_1", expires_at: "2026-10-07T10:00:00Z" } }))).toEqual({
      action: "checkout",
      url: "https://checkout.stripe.com/c/pay/cs_1",
      expiresAt: "2026-10-07T10:00:00Z",
    });
    expect(bookingNextStep(b("requires_user_action", { payment: { mode: "handoff", status: "pending" }, handoff: { url: "https://bookings.vistalink.com/s/abc" } }))).toMatchObject({ action: "handoff", url: "https://bookings.vistalink.com/s/abc" });
    expect(bookingNextStep(b("requires_user_action", { payment: { mode: "external", status: "pending" }, handoff: { url: "https://engine.test/prefilled" } }))).toMatchObject({ action: "external", url: "https://engine.test/prefilled" });
    expect(bookingNextStep(b("processing")).action).toBe("wait");
    expect(bookingNextStep(b("confirmation_pending")).action).toBe("wait");
    for (const s of ["confirmed", "failed", "expired", "canceled"] as const) expect(bookingNextStep(b(s)).action).toBe("done");
  });

  it("bookings.wait stops at canceled", async () => {
    const { vl } = make([{ status: 200, body: b("queued") }, { status: 200, body: b("canceled") }]);
    await expect(vl.bookings.wait("bk_1", { intervalMs: 1 })).resolves.toMatchObject({ status: "canceled" });
  });

  it("a failed booking carries payment_unavailable", async () => {
    const { vl } = make([{ status: 200, body: b("failed", { failure: { reason: "payment_unavailable", message: "no checkout for this property" } }) }]);
    const r = await vl.bookings.get("bk_1");
    expect(r.failure?.reason).toBe("payment_unavailable");
    expect(bookingNextStep(r).action).toBe("done");
  });
});

describe("pagination", () => {
  it("jobs.listAll follows next_cursor", async () => {
    const { vl, calls } = make([
      { status: 200, body: { request_id: "r1", jobs: [JOB("succeeded", { job_id: "a" })], next_cursor: "c2" } },
      { status: 200, body: { request_id: "r2", jobs: [JOB("failed", { job_id: "b" })], next_cursor: null } },
    ]);
    const ids: string[] = [];
    for await (const j of vl.jobs.listAll({ kind: "rates.live" })) ids.push(j.job_id);
    expect(ids).toEqual(["a", "b"]);
    expect(new URL(calls[0].url).searchParams.get("cursor")).toBeNull();
    expect(new URL(calls[1].url).searchParams.get("cursor")).toBe("c2");
    expect(new URL(calls[1].url).searchParams.get("kind")).toBe("rates.live");
  });

  it("search.pages carries search_id and cursor", async () => {
    const { vl, calls } = make([
      { status: 200, body: { request_id: "r", search_id: "srch_1", status: "completed", hotels: [], next_cursor: "p2" } },
      { status: 200, body: { request_id: "r", search_id: "srch_1", status: "completed", hotels: [], next_cursor: null } },
    ]);
    let n = 0;
    for await (const _ of vl.search.pages({ query: "rome" })) n++;
    expect(n).toBe(2);
    expect(calls[1].body).toEqual({ query: "rome", search_id: "srch_1", cursor: "p2" });
  });
});

describe("quotes", () => {
  const q = (status: string, extra = {}) => ({ quote_id: "qte_1", status, hotel_id: "h", offers: [], ...extra });

  it("create sends a generated Idempotency-Key and reuses it on retry", async () => {
    const { vl, calls } = make([
      { status: 503, body: { error: { code: "unavailable", message: "x" } } },
      { status: 202, body: q("contacting") },
    ]);
    const r = await vl.quotes.create({
      hotel_id: "h",
      stay: { check_in: "2026-11-27", check_out: "2026-11-30", rooms: [{ adults: 2, children_ages: [] }] },
    });
    expect(r.quote_id).toBe("qte_1");
    expect(calls[0].url).toBe("https://api.test/v2/quotes");
    const k1 = calls[0].headers.get("idempotency-key");
    expect(k1).toMatch(/^[0-9a-f-]{32,36}$/);
    expect(calls[1].headers.get("idempotency-key")).toBe(k1);
  });

  it("accept posts the guest to the offer with an Idempotency-Key", async () => {
    const { vl, calls } = make([{ status: 200, body: q("accepted", { accepted_offer_id: "qof_1" }) }]);
    const r = await vl.quotes.accept("qte_1", "qof_1", { guest: { first_name: "Ada", last_name: "Rossi", email: "ada@example.com" } }, { idempotencyKey: "acc-1" });
    expect(r.status).toBe("accepted");
    expect(calls[0].url).toBe("https://api.test/v2/quotes/qte_1/offers/qof_1/accept");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("idempotency-key")).toBe("acc-1");
    expect(calls[0].body).toEqual({ guest: { first_name: "Ada", last_name: "Rossi", email: "ada@example.com" } });
  });

  it("get and cancel hit their routes", async () => {
    const { vl, calls } = make([
      { status: 200, body: q("waiting") },
      { status: 200, body: q("cancelled") },
    ]);
    await vl.quotes.get("qte_1");
    await expect(vl.quotes.cancel("qte_1")).resolves.toMatchObject({ status: "cancelled" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.test/v2/quotes/qte_1",
      "POST https://api.test/v2/quotes/qte_1/cancel",
    ]);
  });

  it("wait stops at the first offer, or when the quote closes without one", async () => {
    const { vl } = make([
      { status: 200, body: q("contacting") },
      { status: 200, body: q("waiting") },
      { status: 200, body: q("offer_received", { offers: [{ offer_id: "qof_1", total: "240.00", currency: "EUR" }] }) },
    ]);
    await expect(vl.quotes.wait("qte_1", { intervalMs: 1 })).resolves.toMatchObject({ status: "offer_received" });
    const { vl: vl2 } = make([{ status: 200, body: q("waiting") }, { status: 200, body: q("no_response") }]);
    await expect(vl2.quotes.wait("qte_1", { intervalMs: 1 })).resolves.toMatchObject({ status: "no_response" });
  });
});
