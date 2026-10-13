import { VistaLinkError, parseRetryAfter } from "./errors.js";

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries: number;
  /** First backoff in ms; doubles each attempt, with full jitter. Default 500. */
  baseDelayMs: number;
  /** Upper bound for any single wait (also caps Retry-After). Default 30 000. */
  maxDelayMs: number;
  /** Per-attempt timeout in ms. 0 disables. Default 60 000. */
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  timeoutMs: 60_000,
};

/** Statuses retried for every method: 429 is rejected before any work, 503 is never billed. */
export const RETRY_STATUSES = new Set([429, 503]);

export type Sleep = (ms: number, signal?: AbortSignal | null) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function backoffDelay(attempt: number, opts: RetryOptions, retryAfter: number | null, random = Math.random): number {
  if (retryAfter !== null) return Math.min(opts.maxDelayMs, Math.ceil(retryAfter * 1000));
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2));
}

function withTimeout(signal: AbortSignal | null, timeoutMs: number): { signal: AbortSignal | null; cancel: () => void } {
  if (!timeoutMs) return { signal, cancel: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Wrap a fetch so 429/503 are retried (honouring Retry-After), and network
 * errors are retried only when the request is safe to repeat (GET/DELETE, or
 * a POST that carries an Idempotency-Key — the same key is resent).
 */
export function retryingFetch(
  fetchImpl: (input: Request) => Promise<Response>,
  opts: RetryOptions,
  sleepFn: Sleep = sleep,
): (input: Request) => Promise<Response> {
  return async (request: Request) => {
    const repeatable =
      request.method === "GET" || request.method === "DELETE" || request.headers.has("idempotency-key");
    // Buffer the body once so every attempt sends identical bytes.
    const body = request.body ? await request.arrayBuffer() : undefined;
    for (let attempt = 0; ; attempt++) {
      const timed = withTimeout(request.signal, opts.timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body,
            signal: timed.signal ?? undefined,
            credentials: request.credentials,
            redirect: request.redirect,
          }),
        );
      } catch (cause) {
        timed.cancel();
        if (request.signal?.aborted) throw cause;
        const isTimeout = cause instanceof DOMException && cause.name === "TimeoutError";
        if (repeatable && attempt < opts.maxRetries) {
          await sleepFn(backoffDelay(attempt, opts, null), request.signal);
          continue;
        }
        throw new VistaLinkError({
          code: isTimeout ? "timeout" : "network_error",
          message: isTimeout ? `Request timed out after ${opts.timeoutMs} ms` : `Network error: ${String((cause as Error)?.message ?? cause)}`,
          status: 0,
          cause,
        });
      }
      timed.cancel();
      if (!RETRY_STATUSES.has(response.status) || attempt >= opts.maxRetries) return response;
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      await sleepFn(backoffDelay(attempt, opts, retryAfter), request.signal);
    }
  };
}
