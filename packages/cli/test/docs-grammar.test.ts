import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harness } from "./harness.js";

/**
 * Every CLI sample the vistalink.com docs print (lib/api-docs-text.ts
 * cliSample over content/openapi.v2.json; rebuilt by scripts/docs-samples.mjs)
 * must parse and send exactly the request the docs show.
 */
type Fixture = {
  source: string;
  samples: Array<{ key: string; cli: string; argv: string[]; path: Record<string, string>; query: Record<string, string>; body?: Record<string, unknown>; idempotencyKey?: string }>;
};
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fixture;

/**
 * docs-cli-samples.json: what vistalink.com prints today (its content/openapi.v2.json).
 * spec-cli-samples.json: the same samples built from spec/openapi.v2.json's own
 * examples, i.e. what the docs print once the site serves the generated spec.
 */
describe.each([
  ["docs CLI samples", load("docs-cli-samples.json")],
  ["spec CLI samples", load("spec-cli-samples.json")],
])("%s", (_suite, fixture) => {
  it.each(fixture.samples.map((s) => [s.cli, s] as const))("%s", async (_name, s) => {
    const job = { job_id: "job_1", kind: "rates.batch", status: "succeeded", created_at: "t", updated_at: "t" };
    const h = harness((req) => {
      const p = req.url.pathname;
      if (req.method === "POST" && (p === "/v2/rates/batch" || p === "/v2/rooms/reconcile")) return { status: 202, body: job };
      if (p.startsWith("/v2/jobs/")) return { status: 200, body: job };
      if (req.method === "POST" && p === "/v2/bookings") return { status: 202, body: { booking_id: "bk_1", status: "queued", hotel_id: "h" } };
      return { status: 200, body: { request_id: "r" } };
    });
    const code = await h.run([...s.argv, "--json"]);
    expect(h.err).toBe("");
    expect(code).toBe(0);
    const [method, path] = s.key.split(" ");
    const sent = h.sent[0];
    expect(sent.method).toBe(method);
    expect(sent.url.pathname).toBe(path.replace(/\{(\w+)\}/g, (_, n: string) => encodeURIComponent(s.path[n])));
    expect(Object.fromEntries(sent.url.searchParams)).toEqual(s.query);
    if (s.body) expect(sent.body).toEqual(s.body);
    if (s.idempotencyKey) expect(sent.headers.get("idempotency-key")).toBe(s.idempotencyKey);
  });
});
