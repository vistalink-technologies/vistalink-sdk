export interface Captured {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

/** `text` sends a raw body (e.g. NDJSON) instead of JSON-encoding `body`. */
export type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error;

/** A fetch that records each Request and answers from a queue (last reply repeats). */
export function mockFetch(replies: Reply[]) {
  const calls: Captured[] = [];
  let i = 0;
  const fetch = async (req: Request): Promise<Response> => {
    const text = req.body ? await req.text() : "";
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: text ? JSON.parse(text) : undefined });
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    if (reply.text !== undefined) {
      return new Response(reply.text, { status: reply.status, headers: { "content-type": "application/x-ndjson", ...reply.headers } });
    }
    const headers = { "content-type": "application/json", ...reply.headers };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers });
  };
  return { fetch, calls };
}

export const noSleep = async () => {};

export const JOB = (status: string, extra: Record<string, unknown> = {}) => ({
  job_id: "job_1",
  kind: "rates.live",
  status,
  created_at: "2026-10-07T12:00:00Z",
  updated_at: "2026-10-07T12:00:01Z",
  progress: { done: status === "succeeded" ? 1 : 0, total: 1 },
  ...extra,
});
