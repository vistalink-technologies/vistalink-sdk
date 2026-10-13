import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maskKey } from "../src/credentials.js";
import { table } from "../src/output.js";
import { JOB, harness } from "./harness.js";

describe("table output", () => {
  it("aligns columns, uppercases headers, truncates long cells", () => {
    const t = table(["id", "name"], [["a", "x".repeat(60)], ["bbb", null]]);
    const lines = t.trimEnd().split("\n");
    expect(lines[0]).toBe("ID   NAME");
    expect(lines[1]).toBe(`a    ${"x".repeat(47)}…`);
    expect(lines[2]).toBe("bbb  -");
    expect(table(["a"], [])).toBe("(none)\n");
  });

  it("search results render as a ranked table with a footer", async () => {
    const h = harness([
      {
        status: 200,
        body: {
          request_id: "r", search_id: "srch_1", status: "completed", total_estimate: 143, next_cursor: "c2",
          billing: { sku: "search.loose.semantic", units: 1, amount: "0.012", currency: "USD" },
          hotels: [{ hotel_id: "h1", rank: 1, name: "Umiltà 36", star_rating: 4, review_score: 9.1, location: { city: "Rome" }, rate: { status: "observed", total: "962.00", currency: "EUR" } }],
        },
      },
    ]);
    await h.run(["search", "rome"]);
    expect(h.out).toContain("RANK  HOTEL_ID  NAME       STARS  SCORE  CITY  RATE");
    expect(h.out).toContain("1     h1        Umiltà 36  4      9.1    Rome  962.00 EUR (observed)");
    expect(h.out).toContain("search_id srch_1");
    expect(h.out).toContain("--cursor c2");
    expect(h.out).toContain("billed 0.012 USD (search.loose.semantic)");
  });

  it("clarifications print the question and how to answer", async () => {
    const h = harness([{ status: 200, body: { request_id: "r", search_id: "s1", status: "needs_clarification", clarifications: [{ id: "clar_1", field: "location", question: "Which Cambridge?", options: [{ id: "opt_gb", label: "Cambridge, England" }] }] } }]);
    await h.run(["search", "cambridge"]);
    expect(h.out).toContain("? Which Cambridge?  (clarification_id clar_1)");
    expect(h.out).toContain("opt_gb  Cambridge, England");
  });

  it("--json prints the raw response; jobs render as key/value", async () => {
    const h = harness([{ status: 200, body: JOB("running", { progress: { done: 3, total: 10 } }) }]);
    await h.run(["jobs", "get", "job_1", "--json"]);
    expect(JSON.parse(h.out).status).toBe("running");
    const h2 = harness([{ status: 200, body: JOB("running", { progress: { done: 3, total: 10 } }) }]);
    await h2.run(["jobs", "get", "job_1"]);
    expect(h2.out).toMatch(/^job_id\s+job_1$/m);
    expect(h2.out).toMatch(/^progress\s+3\/10$/m);
  });

  it("webhooks tail prints new deliveries once each", async () => {
    const d = (id: string, status: string, at: string) => ({ delivery_id: id, event: "booking.updated", event_id: "evt", status, attempts: 1, created_at: at });
    let poll = 0;
    const h = harness(() => ({
      status: 200,
      body: { request_id: "r", deliveries: poll++ === 0 ? [d("d2", "pending", "2026-10-07T12:01:00Z"), d("d1", "delivered", "2026-10-07T12:00:00Z")] : [d("d1", "delivered", "2026-10-07T12:00:00Z"), d("d3", "failed", "2026-10-07T12:02:00Z")] },
    }));
    expect(await h.run(["webhooks", "tail", "wh_1", "--max-polls", "2", "--interval", "0"])).toBe(0);
    const lines = h.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^CREATED_AT/);
    expect(lines.slice(1).map((l) => l.split(/\s+/)[1])).toEqual(["d1", "d2", "d3"]);
  });
});

describe("errors → exit codes", () => {
  const err = (status: number, code: string) => ({ status, body: { error: { code, message: `${code} happened`, request_id: "req_42" } } });
  it.each([
    [401, "unauthorized", 3],
    [403, "forbidden", 4],
    [404, "not_found", 5],
    [409, "conflict", 6],
    [429, "rate_limited", 7],
    [402, "insufficient_credit", 8],
    [502, "upstream_error", 9],
    [503, "unavailable", 10],
    [501, "not_implemented", 11],
    [400, "bad_request", 2],
  ])("HTTP %i %s → exit %i", async (status, code, exit) => {
    const h = harness([err(status, code)]);
    expect(await h.run(["jobs", "get", "job_1"])).toBe(exit);
    expect(h.err).toContain(`${code} happened (code=${code} status=${status} request_id=req_42)`);
  });

  it("--json errors go to stderr as JSON", async () => {
    const h = harness([err(403, "forbidden")]);
    await h.run(["jobs", "get", "job_1", "--json"]);
    expect(JSON.parse(h.err).error).toMatchObject({ code: "forbidden", request_id: "req_42", status: 403 });
    expect(h.out).toBe("");
  });

  it("failed job → 14, missing key → 3, validation fields are listed", async () => {
    const h = harness([{ status: 200, body: JOB("failed", { error: { code: "upstream_error", message: "engine down" } }) }]);
    expect(await h.run(["jobs", "wait", "job_1"])).toBe(14);
    const h2 = harness([], { withKey: false });
    expect(await h2.run(["jobs", "list"])).toBe(3);
    expect(h2.err).toContain("vistalink login");
    const h3 = harness([{ status: 400, body: { error: { code: "bad_request", message: "Invalid request", details: { fields: [{ field: "limit", message: "must be ≤ 50" }] } } } }]);
    await h3.run(["search", "x", "--limit", "99"]);
    expect(h3.err).toContain("limit: must be ≤ 50");
  });
});

describe("login, keys, openapi", () => {
  it("login stores the key 0600 and keys list masks it", async () => {
    const h = harness([{ status: 200, body: { request_id: "r", jobs: [] } }], { withKey: false, secret: "vl_live_abcdefghijklmnop\n" });
    expect(await h.run(["login"])).toBe(0);
    expect(h.sent[0].headers.get("authorization")).toBe("Bearer vl_live_abcdefghijklmnop");
    expect(h.out).toContain("vl_live_abcd…mnop");
    const mode = statSync(join(h.dir, "credentials")).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(statSync(join(h.dir, "config.json")).mode & 0o777).toBe(0o600);
    expect(h.store.load("default")?.key).toBe("vl_live_abcdefghijklmnop");

    await h.run(["keys", "list"]);
    expect(h.out).toMatch(/\*\s+default\s+vl_live_abcd…mnop\s+file/);
    expect(h.out).not.toContain("vl_live_abcdefghijklmnop");

    // the stored key is used when no env key is set
    await h.run(["jobs", "list"]);
    expect(h.sent.at(-1)!.headers.get("authorization")).toBe("Bearer vl_live_abcdefghijklmnop");

    expect(await h.run(["logout"])).toBe(0);
    expect(h.store.load("default")).toBeNull();
  });

  it("login rejects non-keys and failing keys", async () => {
    const h = harness([], { withKey: false, secret: "hunter2" });
    expect(await h.run(["login"])).toBe(2);
    const h2 = harness([{ status: 401, body: { error: { code: "unauthorized", message: "Invalid API key" } } }], { withKey: false, secret: "vl_test_bad" });
    expect(await h2.run(["login"])).toBe(3);
    expect(h2.store.profiles()).toEqual({});
  });

  it("keys create/revoke point at the dashboard (exit 11)", async () => {
    const h = harness();
    expect(await h.run(["keys", "create"])).toBe(11);
    expect(h.err).toContain("developers/dashboard");
    expect(await h.run(["keys", "revoke", "key_1"])).toBe(11);
  });

  it("openapi and catalog openapi fetch the document without a key; --url prints where it lives", async () => {
    const doc = { openapi: "3.1.0", info: { title: "VistaLink API", version: "2.0.0" }, paths: {} };
    const h = harness([{ status: 200, body: doc }], { withKey: false });
    expect(await h.run(["openapi"])).toBe(0);
    expect(await h.run(["catalog", "openapi", "--base-url", "https://staging.api.test/"])).toBe(0);
    expect(h.sent.map((s) => s.url.href)).toEqual(["https://api.vistalink.com/v2/openapi.json", "https://staging.api.test/v2/openapi.json"]);
    expect(h.sent.every((s) => !s.headers.has("authorization"))).toBe(true);
    expect(JSON.parse(h.out.split("\n}\n")[0] + "\n}")).toEqual(doc);
    const u = harness([], { withKey: false });
    await u.run(["openapi", "--url"]);
    await u.run(["catalog", "openapi", "--url", "--base-url", "https://staging.api.test/"]);
    expect(u.out).toBe("https://api.vistalink.com/v2/openapi.json\nhttps://staging.api.test/v2/openapi.json\n");
    expect(u.sent).toHaveLength(0);
  });

  it("maskKey", () => {
    expect(maskKey("vl_test_1234567890")).toBe("vl_test_1234…7890");
    expect(maskKey("vl_live_short")).toBe("vl_live_*****");
  });
});
