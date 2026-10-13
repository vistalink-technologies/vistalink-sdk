import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, FileBackend } from "../src/credentials.js";
import { run, type Deps } from "../src/program.js";

export type Reply = { status: number; body?: unknown; headers?: Record<string, string>; text?: string };
export interface Sent {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
}

export function harness(replies: Reply[] | ((req: Sent) => Reply) = [], opts: { env?: Record<string, string>; files?: Record<string, string>; secret?: string; withKey?: boolean } = {}) {
  const sent: Sent[] = [];
  let out = "";
  let err = "";
  const written: Record<string, string> = {};
  const dir = mkdtempSync(join(tmpdir(), "vistalink-cli-"));
  const store = new CredentialStore(dir, { preferred: new FileBackend(dir), byName: () => new FileBackend(dir) });
  let i = 0;
  const deps: Deps = {
    stdout: (s) => void (out += s),
    stderr: (s) => void (err += s),
    env: { ...(opts.withKey === false ? {} : { VISTALINK_API_KEY: "vl_test_envkey123456" }), ...opts.env },
    store,
    readFile: (p) => {
      if (opts.files && p in opts.files) return opts.files[p];
      return readFileSync(p, "utf8");
    },
    writeFile: (p, d) => void (written[p] = d),
    readSecret: async () => opts.secret ?? "",
    sleep: async () => {},
    fetch: async (req) => {
      const text = req.body ? await req.text() : "";
      const s: Sent = { method: req.method, url: new URL(req.url), headers: req.headers, body: text ? JSON.parse(text) : undefined };
      sent.push(s);
      const r = typeof replies === "function" ? replies(s) : replies[Math.min(i++, replies.length - 1)] ?? { status: 200, body: {} };
      const payload = r.text ?? (r.body === undefined ? null : JSON.stringify(r.body));
      return new Response(payload, { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
    },
  };
  return {
    dir,
    store,
    sent,
    written,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    run: (argv: string[]) => run(argv, deps),
  };
}

export const JOB = (status: string, extra: Record<string, unknown> = {}) => ({
  job_id: "job_1",
  kind: "rates.live",
  status,
  created_at: "2026-10-07T12:00:00Z",
  updated_at: "2026-10-07T12:00:01Z",
  progress: { done: 1, total: 1 },
  ...extra,
});
