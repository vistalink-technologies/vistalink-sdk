import { describe, expect, it } from "vitest";
import { hotelRef, hotelsFromFile, parseValue } from "../src/flags.js";
import { JOB, harness } from "./harness.js";

const H1 = "43d0be71-5f3c-4c8e-9a52-1d7e2b6f0a19";
const H2 = "9b2f3c11-0000-4c8e-9a52-1d7e2b6f0a20";

describe("value parsing (docs grammar)", () => {
  const rf = (p: string) => (p === "body.json" ? '{"a":1}' : "");
  it("scalars, lists, JSON and @file", () => {
    expect(parseValue("10", "integer", "limit", rf)).toBe(10);
    expect(() => parseValue("1.5", "integer", "limit", rf)).toThrow("integer");
    expect(parseValue("0.5", "number", "min-confidence", rf)).toBe(0.5);
    expect(parseValue("a,b , c", "list", "events", rf)).toEqual(["a", "b", "c"]);
    expect(parseValue('["a"]', "list", "events", rf)).toEqual(["a"]);
    expect(parseValue(`${H1},${H2}`, "list_or_json", "hotels", rf)).toEqual([H1, H2]);
    expect(parseValue('[{"name":"x"}]', "list_or_json", "hotels", rf)).toEqual([{ name: "x" }]);
    expect(parseValue("@body.json", "json", "stay", rf)).toEqual({ a: 1 });
    expect(() => parseValue("{nope", "json", "stay", rf)).toThrow("--stay expects JSON");
  });

  it("hotel references from bare arguments", () => {
    expect(hotelRef(H1)).toBe(H1);
    expect(hotelRef("https://www.booking.com/hotel/it/umilta-36.en-gb.html")).toEqual({ booking_url: "https://www.booking.com/hotel/it/umilta-36.en-gb.html" });
    expect(hotelRef("https://www.expedia.com/Rome-Hotels-Umilta-36.h12345.Hotel-Information")).toHaveProperty("expedia_url");
    expect(hotelRef("https://umilta36.com")).toEqual({ website_url: "https://umilta36.com" });
    expect(hotelRef("Umiltà 36", { city: "Rome", country: "IT" })).toEqual({ name: "Umiltà 36", city: "Rome", country: "IT" });
    expect(hotelsFromFile(`# hotels\n${H1}\n\nhttps://umilta36.com\n{"name":"X","city":"Rome"}\n`)).toEqual([
      H1,
      { website_url: "https://umilta36.com" },
      { name: "X", city: "Rome" },
    ]);
  });
});

describe("commands → requests", () => {
  it('search "<query>" with convenience filters', async () => {
    const h = harness([{ status: 200, body: { request_id: "r", search_id: "s", status: "completed", hotels: [] } }]);
    const code = await h.run([
      "search", "rooftop near the Pantheon", "--city", "Rome", "--country", "IT", "--check-in", "2026-11-14", "--check-out", "2026-11-16",
      "--adults", "2", "--budget-max", "400", "--currency", "EUR", "--ranking", "semantic", "--limit", "5",
    ]);
    expect(code).toBe(0);
    expect(h.sent[0].method).toBe("POST");
    expect(h.sent[0].url.pathname).toBe("/v2/search");
    expect(h.sent[0].body).toEqual({
      query: "rooftop near the Pantheon",
      currency: "EUR",
      ranking: "semantic",
      limit: 5,
      filters: {
        location: { city: "Rome", country: "IT" },
        stay: { check_in: "2026-11-14", check_out: "2026-11-16", rooms: [{ adults: 2 }] },
        budget: { max: "400", currency: "EUR" },
      },
    });
    expect(h.sent[0].headers.get("authorization")).toBe("Bearer vl_test_envkey123456");
  });

  it("search run (docs grammar) and the budget/currency rule", async () => {
    const h = harness([{ status: 200, body: { request_id: "r", status: "completed", hotels: [] } }]);
    expect(await h.run(["search", "run", "--query", "x", "--filters", '{"min_stars":4}', "--limit", "3"])).toBe(0);
    expect(h.sent[0].body).toEqual({ query: "x", filters: { min_stars: 4 }, limit: 3 });
    expect(await h.run(["search", "x", "--budget-max", "400"])).toBe(2);
    expect(h.err).toContain("--currency");
    expect(await h.run(["search"])).toBe(2);
  });

  it("hotel <id> and hotels get <id> map flags to the query string", async () => {
    const h = harness([{ status: 200, body: { request_id: "r", hotel_id: H1, core: { name: "Umiltà 36" } } }]);
    for (const argv of [["hotel", H1], ["hotels", "get", H1]]) {
      expect(await h.run([...argv, "--sections", "core,rooms", "--check-in", "2026-11-14", "--check-out", "2026-11-16", "--search-id", "srch_1"])).toBe(0);
    }
    for (const s of h.sent) {
      expect(s.method).toBe("GET");
      expect(s.url.pathname).toBe(`/v2/hotels/${H1}`);
      expect(Object.fromEntries(s.url.searchParams)).toEqual({ sections: "core,rooms", check_in: "2026-11-14", check_out: "2026-11-16", search_id: "srch_1" });
    }
  });

  it("rates <ids...> --live waits for the job and prints its result", async () => {
    const result = { request_id: "r", results: [{ input: 0, hotel_id: H1, status: "observed", channel: "direct", rooms: [] }] };
    const h = harness((req) => (req.method === "POST" ? { status: 202, body: JOB("queued") } : { status: 200, body: JOB("succeeded", { result }) }));
    const code = await h.run(["rates", H1, "https://umilta36.com", "--check-in", "2026-11-14", "--check-out", "2026-11-16", "--live", "--channel", "direct", "--json"]);
    expect(code).toBe(0);
    expect(h.sent[0].body).toEqual({
      hotels: [H1, { website_url: "https://umilta36.com" }],
      stay: { check_in: "2026-11-14", check_out: "2026-11-16" },
      channel: "direct",
      freshness: "live",
    });
    expect(h.sent[0].headers.get("idempotency-key")).toBeTruthy();
    expect(h.sent[1].url.pathname).toBe("/v2/jobs/job_1");
    expect(JSON.parse(h.out)).toEqual(result);
  });

  it("rates get (cached) sends no Idempotency-Key unless given", async () => {
    const h = harness([{ status: 200, body: { request_id: "r", results: [] } }]);
    await h.run(["rates", "get", "--hotels", `${H1},${H2}`, "--stay", '{"check_in":"2026-11-14","check_out":"2026-11-16"}']);
    expect(h.sent[0].body.hotels).toEqual([H1, H2]);
    expect(h.sent[0].headers.has("idempotency-key")).toBe(false);
    await h.run(["rates", "get", "--hotels", H1, "--check-in", "2026-11-14", "--check-out", "2026-11-15", "--idempotency-key", "k1"]);
    expect(h.sent[1].headers.get("idempotency-key")).toBe("k1");
  });

  it("rates batch --file waits and downloads the NDJSON", async () => {
    const ndjson = `{"hotel_id":"${H1}","status":"observed"}\n{"hotel_id":"${H2}","status":"unknown"}\n`;
    const h = harness(
      (req) =>
        req.url.hostname === "files.test"
          ? { status: 200, text: ndjson }
          : req.method === "POST"
            ? { status: 202, body: JOB("queued", { kind: "rates.batch" }) }
            : { status: 200, body: JOB("succeeded", { kind: "rates.batch", result_url: "https://files.test/r.ndjson?sig=abc" }) },
      { files: { "hotels.txt": `${H1}\n${H2}\n` } },
    );
    const code = await h.run(["rates", "batch", "--file", "hotels.txt", "--check-in", "2026-11-14", "--check-out", "2026-11-16", "--out", "out.ndjson"]);
    expect(code).toBe(0);
    expect(h.sent[0].body).toEqual({ hotels: [H1, H2], stays: [{ check_in: "2026-11-14", check_out: "2026-11-16" }] });
    expect(h.sent[0].headers.get("idempotency-key")).toBeTruthy();
    const download = h.sent.find((s) => s.url.hostname === "files.test")!;
    expect(download.headers.has("authorization")).toBe(false);
    expect(h.written["out.ndjson"]).toBe(ndjson);
  });

  it("rates batch downloads GET /v2/jobs/{id}/result with the key when result_url is null", async () => {
    const ndjson = `{"hotel_id":"${H1}","status":"observed"}\n`;
    const h = harness(
      (req) =>
        req.url.pathname === "/v2/jobs/job_1/result"
          ? { status: 200, text: ndjson, headers: { "content-type": "application/x-ndjson" } }
          : req.method === "POST"
            ? { status: 202, body: JOB("queued", { kind: "rates.batch" }) }
            : { status: 200, body: JOB("succeeded", { kind: "rates.batch", result_url: null }) },
      { files: { "hotels.txt": `${H1}\n` } },
    );
    expect(await h.run(["rates", "batch", "--file", "hotels.txt", "--check-in", "2026-11-14", "--check-out", "2026-11-16"])).toBe(0);
    const dl = h.sent.at(-1)!;
    expect(`${dl.method} ${dl.url.pathname}`).toBe("GET /v2/jobs/job_1/result");
    expect(dl.headers.get("authorization")).toBe("Bearer vl_test_envkey123456");
    expect(h.out).toBe(ndjson);
  });

  it("jobs wait downloads a rates.batch result; jobs result prints the NDJSON", async () => {
    const ndjson = `{"hotel_id":"${H1}","status":"observed"}\n{"hotel_id":"${H2}","status":"unknown"}\n`;
    const h = harness((req) =>
      req.url.pathname.endsWith("/result")
        ? { status: 200, text: ndjson, headers: { "content-type": "application/x-ndjson" } }
        : { status: 200, body: JOB("succeeded", { kind: "rates.batch", result_url: null }) },
    );
    expect(await h.run(["jobs", "wait", "job_1", "--out", "r.ndjson"])).toBe(0);
    expect(h.written["r.ndjson"]).toBe(ndjson);
    expect(h.sent.map((s) => s.url.pathname)).toEqual(["/v2/jobs/job_1", "/v2/jobs/job_1/result"]);
    expect(await h.run(["jobs", "wait", "job_1", "--no-download", "--json"])).toBe(0);
    expect(JSON.parse(h.out).kind).toBe("rates.batch");
    expect(await h.run(["jobs", "result", "job_1"])).toBe(0);
    expect(h.out.endsWith(ndjson)).toBe(true);
    expect(h.sent.at(-1)!.url.pathname).toBe("/v2/jobs/job_1/result");
  });

  it("bookings create --payment-mode takes the three modes and prints the next step", async () => {
    const handoff = { booking_id: "bk_2", status: "requires_user_action", hotel_id: H1, payment: { mode: "external", status: "pending" }, handoff: { url: "https://engine.test/prefilled" } };
    const h = harness([{ status: 202, body: { booking_id: "bk_2", status: "queued", hotel_id: H1 } }, { status: 200, body: handoff }]);
    const base = ["bookings", "create", "--hotel-id", H1, "--offer-id", "off_1", "--stay", '{"check_in":"2026-11-14","check_out":"2026-11-16"}', "--guests", '[{"room":0,"lead":{"first_name":"Ada","last_name":"Rossi","email":"ada@example.com","phone":"+390600000000"}}]'];
    expect(await h.run([...base, "--payment-mode", "external", "--wait"])).toBe(0);
    expect(h.sent[0].body.payment).toEqual({ mode: "external" });
    expect(h.sent[0].headers.get("idempotency-key")).toBeTruthy();
    expect(h.out).toMatch(/next\s+external: send the guest to https:\/\/engine\.test\/prefilled/);
    expect(h.err).toContain("next: external → https://engine.test/prefilled");
    expect(await h.run([...base, "--payment-mode", "handoff", "--return-url", "https://p.example/done"])).toBe(0);
    expect(h.sent.at(-1)!.body.payment).toEqual({ mode: "handoff", return_url: "https://p.example/done" });
    expect(await h.run([...base, "--payment-mode", "card"])).toBe(2);
  });

  it("a canceled booking renders as final", async () => {
    const h = harness([{ status: 200, body: { booking_id: "bk_3", status: "canceled", hotel_id: H1, payment: { mode: "checkout", status: "expired" } } }]);
    expect(await h.run(["bookings", "cancel", "bk_3"])).toBe(0);
    expect(h.out).toMatch(/status\s+canceled/);
    expect(h.out).not.toContain("next");
  });

  it("rooms reconcile --hotel --source --supplied", async () => {
    const h = harness([{ status: 202, body: JOB("queued", { kind: "rooms.reconcile" }) }], {
      files: { "rooms.json": '[{"key":"SUP-K","name":"Superior King","size_m2":28}]' },
    });
    const code = await h.run([
      "rooms", "reconcile", "--hotel", H1, "--source", "booking_url=https://www.booking.com/hotel/it/umilta-36.html",
      "--source", "website_url=https://umilta36.com", "--supplied", "rooms.json", "--no-wait", "--json",
    ]);
    expect(code).toBe(0);
    expect(h.sent[0].body).toEqual({
      hotel_id: H1,
      sources: [
        { kind: "booking_url", url: "https://www.booking.com/hotel/it/umilta-36.html" },
        { kind: "website_url", url: "https://umilta36.com" },
        { kind: "rooms", label: "supplied", rooms: [{ key: "SUP-K", name: "Superior King", size_m2: 28 }] },
      ],
    });
    expect(JSON.parse(h.out).job_id).toBe("job_1");
    expect(await h.run(["rooms", "reconcile", "--hotel", H1, "--source", "airbnb=https://x"])).toBe(2);
  });

  it("bookings create --data @file with --idempotency-key; get; cancel", async () => {
    const booking = { booking_id: "bk_1", status: "requires_payment", hotel_id: H1, payment: { mode: "checkout", status: "pending", checkout_url: "https://checkout.stripe.com/c/pay/cs_1", payee: "property" } };
    const h = harness([{ status: 202, body: booking }], {
      files: {
        "booking.json": JSON.stringify({
          hotel_id: H1, offer_id: "off_1", stay: { check_in: "2026-11-14", check_out: "2026-11-16" },
          guests: [{ room: 0, lead: { first_name: "Ada", last_name: "Rossi", email: "ada@example.com", phone: "+390600000000" } }], payment: { mode: "checkout" },
        }),
      },
    });
    expect(await h.run(["bookings", "create", "--data", "@booking.json", "--special-requests", "Late arrival", "--idempotency-key", "bk-ada-1"])).toBe(0);
    expect(h.sent[0].headers.get("idempotency-key")).toBe("bk-ada-1");
    expect(h.sent[0].body.special_requests).toBe("Late arrival");
    expect(h.out).toContain("checkout.stripe.com");
    await h.run(["bookings", "get", "bk_1"]);
    await h.run(["bookings", "cancel", "bk_1"]);
    expect(h.sent.slice(1).map((s) => `${s.method} ${s.url.pathname}`)).toEqual(["GET /v2/bookings/bk_1", "POST /v2/bookings/bk_1/cancel"]);
    expect(await h.run(["bookings", "create", "--hotel-id", H1])).toBe(2);
    expect(h.err).toContain("Missing required --offer-id");
  });

  it("jobs list/get/wait/cancel and webhooks commands", async () => {
    const h = harness((req) => {
      if (req.url.pathname === "/v2/jobs") return { status: 200, body: { request_id: "r", jobs: [JOB("succeeded")], next_cursor: null } };
      if (req.url.pathname.startsWith("/v2/jobs/")) return { status: 200, body: JOB("succeeded") };
      if (req.url.pathname === "/v2/webhooks" && req.method === "POST") return { status: 201, body: { request_id: "r", webhook_id: "wh_1", url: "https://x.example/h", events: ["booking.updated"], created_at: "2026-10-07T12:00:00Z", secret: "whsec_1" } };
      if (req.method === "DELETE") return { status: 204 };
      return { status: 200, body: { request_id: "r", webhooks: [] } };
    });
    expect(await h.run(["jobs", "list", "--kind", "rates.live", "--limit", "5"])).toBe(0);
    expect(Object.fromEntries(h.sent[0].url.searchParams)).toEqual({ kind: "rates.live", limit: "5" });
    expect(await h.run(["jobs", "wait", "job_1"])).toBe(0);
    expect(await h.run(["jobs", "cancel", "job_1"])).toBe(0);
    expect(await h.run(["webhooks", "create", "--url", "https://x.example/h", "--events", "booking.updated,rates.completed"])).toBe(0);
    expect(h.sent.at(-1)!.body).toEqual({ url: "https://x.example/h", events: ["booking.updated", "rates.completed"] });
    expect(h.out).toContain("whsec_1");
    expect(await h.run(["webhooks", "delete", "wh_1"])).toBe(0);
    expect(h.sent.at(-1)!.method).toBe("DELETE");
    expect(h.out.endsWith("deleted\n")).toBe(true);
    expect(await h.run(["webhooks", "delete", "wh_1", "--json"])).toBe(0);
    expect(JSON.parse(h.out.slice(h.out.lastIndexOf("{")))).toEqual({ webhook_id: "wh_1", deleted: true });
  });

  it("resolve <inputs...> builds identifiers", async () => {
    const h = harness([{ status: 200, body: { request_id: "r", billing: null, results: [] } }]);
    await h.run(["resolve", "https://www.booking.com/hotel/it/umilta-36.en-gb.html", "Umiltà 36", "--city", "Rome", "--country", "IT"]);
    expect(h.sent[0].body).toEqual({
      identifiers: [{ booking_url: "https://www.booking.com/hotel/it/umilta-36.en-gb.html" }, { name: "Umiltà 36", city: "Rome", country: "IT" }],
    });
  });

  it("unknown options and commands are usage errors (exit 2)", async () => {
    const h = harness();
    expect(await h.run(["search", "run", "--nope", "x"])).toBe(2);
    expect(await h.run(["frobnicate"])).toBe(2);
    expect(await h.run(["--help"])).toBe(0);
    expect(h.sent).toHaveLength(0);
  });
});
