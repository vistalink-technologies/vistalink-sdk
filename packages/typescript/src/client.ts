import createClient, { type Client } from "openapi-fetch";
import type { components, paths } from "./generated/schema.js";
import { VistaLinkError } from "./errors.js";
import { DEFAULT_RETRY, type RetryOptions, retryingFetch, sleep as defaultSleep, type Sleep } from "./retry.js";
import { paginate, paginateItems } from "./pagination.js";
import { verifyWebhook, type HeadersLike, type VerifyOptions, type WebhookEvent } from "./webhooks.js";

export const SDK_VERSION = "2.1.0";
export const DEFAULT_BASE_URL = "https://api.vistalink.com";

type S = components["schemas"];
export type Job = S["Job"];
export type JobStatus = Job["status"];
export type Booking = S["Booking"];
export type BookingStatus = Booking["status"];
export type PaymentMode = S["Payment"]["mode"];
export type Quote = S["Quote"];
export type QuoteStatus = Quote["status"];
export type HotelDetailQuery = NonNullable<paths["/v2/hotels/{hotel_id}"]["get"]["parameters"]["query"]>;
export type JobListQuery = NonNullable<paths["/v2/jobs"]["get"]["parameters"]["query"]>;
export type DeliveryListQuery = NonNullable<paths["/v2/webhooks/{webhook_id}/deliveries"]["get"]["parameters"]["query"]>;

export interface VistaLinkOptions {
  /** `vl_live_…` or `vl_test_…`. Only `catalog.health()` and the spec work without one. */
  apiKey?: string;
  /** Default `https://api.vistalink.com`. */
  baseUrl?: string;
  /** Retries after the first attempt for 429/503 (and safe network errors). Default 3. */
  maxRetries?: number;
  /** Per-attempt timeout in ms (0 = none). Default 60 000. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Receives a `Request`. */
  fetch?: (input: Request) => Promise<Response>;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Override the wait used between retries and polls (tests). */
  sleep?: Sleep;
  /** Idempotency-Key generator. Default `crypto.randomUUID()`. */
  idempotencyKey?: () => string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface IdempotentRequestOptions extends RequestOptions {
  /** Sent as `Idempotency-Key`. Generated when omitted; reuse it to retry safely across processes. */
  idempotencyKey?: string;
}

export interface WaitOptions {
  /** Give up after this long (ms). Default 10 minutes. */
  timeoutMs?: number;
  /** First poll interval (ms). Grows ×1.5 up to `maxIntervalMs`. Default 2 000. */
  intervalMs?: number;
  /** Default 15 000. */
  maxIntervalMs?: number;
  signal?: AbortSignal;
  /** Called after every poll. */
  onPoll?: (value: Job) => void;
  /** Throw `VistaLinkError{code: "job_failed" | "job_canceled"}` for those outcomes. Default true. */
  throwOnFailure?: boolean;
}

export interface QuoteWaitOptions extends Omit<WaitOptions, "onPoll" | "throwOnFailure"> {
  /** Stop when the quote reaches one of these. Default: an offer to act on, or a closed quote. */
  until?: QuoteStatus[];
  onPoll?: (value: Quote) => void;
}

/** Quote states that never change again (`accepted` can still gain the hotel's late confirmation). */
export const QUOTE_FINAL: ReadonlySet<QuoteStatus> = new Set<QuoteStatus>([
  "accepted",
  "completed",
  "no_response",
  "declined",
  "cancelled",
  "failed",
]);
/** Where `quotes.wait` stops by default: the first offer, or the quote closing without one. */
export const QUOTE_STOP_DEFAULT: readonly QuoteStatus[] = ["offer_received", ...QUOTE_FINAL];

export interface BookingWaitOptions extends Omit<WaitOptions, "onPoll" | "throwOnFailure"> {
  /** Stop when the booking reaches one of these. Default: every state that needs the caller or is final. */
  until?: BookingStatus[];
  onPoll?: (value: Booking) => void;
}

export const JOB_TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["succeeded", "failed", "canceled"]);
/** Booking states that never change again. */
export const BOOKING_FINAL: ReadonlySet<BookingStatus> = new Set<BookingStatus>(["confirmed", "failed", "expired", "canceled"]);
export const BOOKING_STOP_DEFAULT: readonly BookingStatus[] = [
  "requires_payment",
  "requires_user_action",
  "confirmed",
  "confirmation_pending",
  "failed",
  "expired",
  "canceled",
];

/**
 * What the caller has to do next with a booking, by payment mode:
 * - `checkout`: `requires_payment` → send the guest to `payment.checkout_url` (they pay the property).
 * - `handoff`: `requires_user_action` → send the guest to the hosted session at `handoff.url`.
 * - `external`: `requires_user_action` → send the guest to the engine's own prefilled page at `handoff.url`.
 * - `wait`: still `queued | processing | confirmation_pending`; poll or listen for `booking.updated`.
 * - `done`: final (`confirmed | failed | expired | canceled`); see `failure.reason` when not confirmed.
 */
export type BookingNextStep =
  | { action: "checkout" | "handoff" | "external"; url: string; expiresAt: string | null }
  | { action: "wait" | "done"; url: null; expiresAt: null };

export function bookingNextStep(b: Booking): BookingNextStep {
  const mode = b.payment?.mode;
  if (b.status === "requires_payment" && b.payment?.checkout_url) {
    return { action: "checkout", url: b.payment.checkout_url, expiresAt: b.payment.expires_at ?? null };
  }
  if (b.status === "requires_user_action" && b.handoff?.url) {
    return { action: mode === "external" ? "external" : "handoff", url: b.handoff.url, expiresAt: b.handoff.expires_at ?? null };
  }
  return { action: BOOKING_FINAL.has(b.status) ? "done" : "wait", url: null, expiresAt: null };
}

/** Split an NDJSON document (a `rates.batch` result) into parsed rows. */
export function parseNdjson<T = Record<string, unknown>>(text: string): T[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

/** Narrow a 200-or-202 answer: `if (isJob(r)) await vl.jobs.wait(r.job_id)`. */
export function isJob(value: unknown): value is Job {
  return !!value && typeof value === "object" && "job_id" in value && "kind" in value && "status" in value;
}

function defaultIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type FetchResult<T> = { data?: T; error?: unknown; response: Response };

/**
 * VistaLink API v2 client.
 *
 * ```ts
 * const vl = new VistaLink({ apiKey: process.env.VISTALINK_API_KEY });
 * const { hotels } = await vl.search.run({ query: "rooftop near the Pantheon" });
 * ```
 */
export class VistaLink {
  /** The underlying typed openapi-fetch client, for anything the helpers do not cover. */
  readonly raw: Client<paths>;
  readonly baseUrl: string;
  readonly openapiUrl: string;
  private readonly sleep: Sleep;
  private readonly newKey: () => string;
  /** @internal the retrying fetch, without the client's default headers (signed result downloads). */
  readonly _fetch: (input: Request) => Promise<Response>;

  readonly hotels: HotelsResource;
  readonly search: SearchResource;
  readonly rates: RatesResource;
  readonly rooms: RoomsResource;
  readonly bookings: BookingsResource;
  readonly quotes: QuotesResource;
  readonly jobs: JobsResource;
  readonly webhooks: WebhooksResource;
  readonly chat: ChatResource;
  readonly catalog: CatalogResource;

  constructor(opts: VistaLinkOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.openapiUrl = `${this.baseUrl}/v2/openapi.json`;
    this.sleep = opts.sleep ?? defaultSleep;
    this.newKey = opts.idempotencyKey ?? defaultIdempotencyKey;
    const retry: RetryOptions = {
      ...DEFAULT_RETRY,
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    };
    const baseFetch = opts.fetch ?? ((r: Request) => globalThis.fetch(r));
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-VistaLink-Client": `vistalink-ts/${SDK_VERSION}`,
      ...opts.headers,
    };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    this._fetch = retryingFetch(baseFetch, retry, this.sleep);
    this.raw = createClient<paths>({ baseUrl: this.baseUrl, headers, fetch: this._fetch });
    this.hotels = new HotelsResource(this);
    this.search = new SearchResource(this);
    this.rates = new RatesResource(this);
    this.rooms = new RoomsResource(this);
    this.bookings = new BookingsResource(this);
    this.quotes = new QuotesResource(this);
    this.jobs = new JobsResource(this);
    this.webhooks = new WebhooksResource(this);
    this.chat = new ChatResource(this);
    this.catalog = new CatalogResource(this);
  }

  /** @internal unwrap an openapi-fetch result or throw `VistaLinkError`. */
  async _unwrap<T>(p: Promise<FetchResult<T>>): Promise<T> {
    let r: FetchResult<T>;
    try {
      r = await p;
    } catch (cause) {
      if (cause instanceof VistaLinkError) throw cause;
      if ((cause as Error)?.name === "AbortError") throw cause;
      throw new VistaLinkError({ code: "network_error", message: String((cause as Error)?.message ?? cause), status: 0, cause });
    }
    if (!r.response.ok) throw VistaLinkError.fromResponse(r.response.status, r.error, r.response.headers);
    if (r.response.status === 204) return {} as T; // no body (e.g. a DELETE answered 204)
    if (r.data === undefined) {
      throw new VistaLinkError({
        code: "invalid_response",
        message: `Empty response body (HTTP ${r.response.status})`,
        status: r.response.status,
        requestId: r.response.headers.get("x-request-id"),
      });
    }
    return r.data;
  }

  /** @internal request headers plus an `Idempotency-Key` (the caller's, or a fresh one). */
  _idem(opts?: IdempotentRequestOptions): Record<string, string> {
    return { ...opts?.headers, "Idempotency-Key": opts?.idempotencyKey ?? this.newKey() };
  }

  /** @internal the declared `Idempotency-Key` header parameter. */
  _idemParams(opts?: IdempotentRequestOptions): { header: { "Idempotency-Key": string } } {
    return { header: { "Idempotency-Key": opts?.idempotencyKey ?? this.newKey() } };
  }

  /** @internal generic poller */
  async _poll<T>(
    get: () => Promise<T>,
    done: (v: T) => boolean,
    opts: { timeoutMs?: number; intervalMs?: number; maxIntervalMs?: number; signal?: AbortSignal; onPoll?: (v: T) => void },
    what: string,
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let interval = opts.intervalMs ?? 2_000;
    const maxInterval = opts.maxIntervalMs ?? 15_000;
    for (;;) {
      const value = await get();
      opts.onPoll?.(value);
      if (done(value)) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new VistaLinkError({ code: "timeout", message: `Timed out after ${timeoutMs} ms waiting for ${what}`, status: 0, details: { last: value } });
      }
      await this.sleep(Math.min(interval, remaining), opts.signal);
      interval = Math.min(maxInterval, Math.round(interval * 1.5));
    }
  }
}

class Resource {
  constructor(protected readonly vl: VistaLink) {}
}

export class HotelsResource extends Resource {
  /** `POST /v2/hotels/resolve` — free. Up to 500 identifiers. */
  resolve(body: S["ResolveRequest"], opts?: RequestOptions): Promise<S["ResolveResponse"]> {
    return this.vl._unwrap(this.vl.raw.POST("/v2/hotels/resolve", { body, ...opts }));
  }

  /** `GET /v2/hotels/{hotel_id}`. Pass `search_id` from a search to hit the warmed cache. */
  get(hotelId: string, query?: HotelDetailQuery, opts?: RequestOptions): Promise<S["HotelDetailResponse"]> {
    return this.vl._unwrap(
      this.vl.raw.GET("/v2/hotels/{hotel_id}", { params: { path: { hotel_id: hotelId }, query }, ...opts }),
    );
  }
}

export class SearchResource extends Resource {
  /** `POST /v2/search`. */
  run(body: S["SearchRequest"], opts?: RequestOptions): Promise<S["SearchResponse"]> {
    return this.vl._unwrap(this.vl.raw.POST("/v2/search", { body, ...opts }));
  }

  /** Answer a `needs_clarification` response. */
  answer(searchId: string, answers: S["ClarificationAnswer"][], opts?: RequestOptions): Promise<S["SearchResponse"]> {
    return this.run({ search_id: searchId, answers }, opts);
  }

  /** Every page of a search (`cursor` → `next_cursor`). Pages after the first are free. */
  pages(body: S["SearchRequest"], opts?: RequestOptions & { maxPages?: number }): AsyncGenerator<S["SearchResponse"]> {
    let searchId: string | undefined;
    return paginate(async (cursor) => {
      const page = await this.run(cursor ? { ...body, search_id: searchId ?? body.search_id, cursor } : body, opts);
      searchId = page.search_id ?? searchId;
      return page;
    }, opts);
  }
}

export class RatesResource extends Resource {
  /** `POST /v2/rates` as sent: cached → `RatesResponse` (200), live → `Job` (202). Use `isJob()` to narrow. */
  get(body: S["RatesRequest"], opts?: IdempotentRequestOptions): Promise<S["RatesResponse"] | Job> {
    const live = body.freshness === "live" || opts?.idempotencyKey !== undefined;
    const params = live ? this.vl._idemParams(opts) : undefined;
    return this.vl._unwrap(this.vl.raw.POST("/v2/rates", { body, params, signal: opts?.signal, headers: opts?.headers }));
  }

  /** Cached rates, sync. Billed per hotel `observed` (or `stale` within `max_age_hours`). */
  async cached(body: Omit<S["RatesRequest"], "freshness">, opts?: RequestOptions): Promise<S["RatesResponse"]> {
    const r = await this.get({ ...body, freshness: "cached" }, opts);
    if (isJob(r)) throw new VistaLinkError({ code: "invalid_response", message: "Expected cached rates, got a job", status: 202 });
    return r;
  }

  /** Live rates: starts a `rates.live` job (202). Wait with `jobs.wait(job.job_id)`. */
  async live(body: Omit<S["RatesRequest"], "freshness">, opts?: IdempotentRequestOptions): Promise<Job> {
    const r = await this.get({ ...body, freshness: "live" }, opts);
    if (!isJob(r)) throw new VistaLinkError({ code: "invalid_response", message: "Expected a job for live rates", status: 200 });
    return r;
  }

  /**
   * `POST /v2/rates/batch` — 202 `rates.batch` job. When it succeeds the NDJSON
   * result comes from `jobs.download(job)` (`result_url`, or `GET /v2/jobs/{id}/result`).
   */
  batch(body: S["RatesBatchRequest"], opts?: IdempotentRequestOptions): Promise<Job> {
    return this.vl._unwrap(
      this.vl.raw.POST("/v2/rates/batch", { body, params: this.vl._idemParams(opts), signal: opts?.signal, headers: opts?.headers }),
    );
  }
}

export class RoomsResource extends Resource {
  /** `POST /v2/rooms/reconcile` — 202 job, or 200 result when every source is supplied rooms for a known hotel. */
  reconcile(body: S["ReconcileRequest"], opts?: IdempotentRequestOptions): Promise<S["ReconcileResult"] | Job> {
    return this.vl._unwrap(
      this.vl.raw.POST("/v2/rooms/reconcile", { body, params: this.vl._idemParams(opts), signal: opts?.signal, headers: opts?.headers }),
    );
  }
}

export class BookingsResource extends Resource {
  /**
   * `POST /v2/bookings` — `Idempotency-Key` is required by the API and generated here when omitted.
   * `payment.mode` is `checkout` (hosted checkout link), `handoff` (hosted guest session) or
   * `external` (the engine's own prefilled page); the guest always pays the property.
   */
  create(body: S["BookingRequest"], opts?: IdempotentRequestOptions): Promise<Booking> {
    return this.vl._unwrap(
      this.vl.raw.POST("/v2/bookings", { body, params: this.vl._idemParams(opts), signal: opts?.signal, headers: opts?.headers }),
    );
  }

  get(bookingId: string, opts?: RequestOptions): Promise<Booking> {
    return this.vl._unwrap(this.vl.raw.GET("/v2/bookings/{booking_id}", { params: { path: { booking_id: bookingId } }, ...opts }));
  }

  /**
   * Moves the booking to `canceled`. Allowed while `queued | requires_payment | requires_user_action`,
   * and while `processing` before the engine submit (409 `conflict` after it).
   */
  cancel(bookingId: string, opts?: RequestOptions): Promise<Booking> {
    return this.vl._unwrap(
      this.vl.raw.POST("/v2/bookings/{booking_id}/cancel", { params: { path: { booking_id: bookingId } }, ...opts }),
    );
  }

  /**
   * Poll until the booking needs the caller or is final (`confirmed | failed | expired | canceled`,
   * or `confirmation_pending`). `bookingNextStep(b)` says what to show: `payment.checkout_url`
   * (mode `checkout`) or `handoff.url` (modes `handoff` and `external`).
   */
  wait(bookingId: string, opts: BookingWaitOptions = {}): Promise<Booking> {
    const until = new Set<BookingStatus>(opts.until ?? BOOKING_STOP_DEFAULT);
    return this.vl._poll(() => this.get(bookingId, { signal: opts.signal }), (b) => until.has(b.status), opts, `booking ${bookingId}`);
  }
}

export class QuotesResource extends Resource {
  /**
   * `POST /v2/quotes` — VistaLink emails the hotel for a direct price on the stay, on behalf of a
   * guest it does not name. `Idempotency-Key` is required by the API and generated here when omitted.
   * Answers with the Quote (202), or the open quote for the same hotel and stay (200, no new email).
   * $0.25 per quote the hotel answers with a price; test keys get a simulated hotel (`sandbox_outcome`).
   */
  create(body: S["QuoteRequest"], opts?: IdempotentRequestOptions): Promise<Quote> {
    return this.vl._unwrap(
      this.vl.raw.POST("/v2/quotes", { body, params: this.vl._idemParams(opts), signal: opts?.signal, headers: opts?.headers }),
    );
  }

  get(quoteId: string, opts?: RequestOptions): Promise<Quote> {
    return this.vl._unwrap(this.vl.raw.GET("/v2/quotes/{quote_id}", { params: { path: { quote_id: quoteId } }, ...opts }));
  }

  /** Stops further emails to the hotel. Free; a quote cancelled after a priced offer keeps its charge. */
  cancel(quoteId: string, opts?: RequestOptions): Promise<Quote> {
    return this.vl._unwrap(
      this.vl.raw.POST("/v2/quotes/{quote_id}/cancel", { params: { path: { quote_id: quoteId } }, ...opts }),
    );
  }

  /**
   * Accept one offer: the hotel gets ONE introduction email with the guest copied, and confirms the
   * booking with them directly. It can't be taken back. Free. Sends an `Idempotency-Key` (generated
   * when omitted), so a retry never introduces the guest twice.
   */
  accept(quoteId: string, offerId: string, body: S["QuoteAcceptRequest"], opts?: IdempotentRequestOptions): Promise<Quote> {
    return this.vl._unwrap(
      this.vl.raw.POST("/v2/quotes/{quote_id}/offers/{offer_id}/accept", {
        body,
        params: { path: { quote_id: quoteId, offer_id: offerId }, ...this.vl._idemParams(opts) },
        signal: opts?.signal,
        headers: opts?.headers,
      }),
    );
  }

  /** Poll until the quote has an offer or closes (`QUOTE_STOP_DEFAULT`). Hotels usually reply within hours. */
  wait(quoteId: string, opts: QuoteWaitOptions = {}): Promise<Quote> {
    const until = new Set<QuoteStatus>(opts.until ?? QUOTE_STOP_DEFAULT);
    return this.vl._poll(() => this.get(quoteId, { signal: opts.signal }), (q) => until.has(q.status), opts, `quote ${quoteId}`);
  }
}

export class JobsResource extends Resource {
  get(jobId: string, opts?: RequestOptions): Promise<Job> {
    return this.vl._unwrap(this.vl.raw.GET("/v2/jobs/{job_id}", { params: { path: { job_id: jobId } }, ...opts }));
  }

  list(query?: JobListQuery, opts?: RequestOptions): Promise<S["JobList"]> {
    return this.vl._unwrap(this.vl.raw.GET("/v2/jobs", { params: { query }, ...opts }));
  }

  /** Every job across pages. */
  listAll(query: Omit<JobListQuery, "cursor"> = {}, opts?: RequestOptions & { maxPages?: number }): AsyncGenerator<Job> {
    return paginateItems((cursor) => this.list({ ...query, cursor }, opts), (p) => p.jobs, opts);
  }

  cancel(jobId: string, opts?: RequestOptions): Promise<Job> {
    return this.vl._unwrap(this.vl.raw.POST("/v2/jobs/{job_id}/cancel", { params: { path: { job_id: jobId } }, ...opts }));
  }

  /**
   * `GET /v2/jobs/{id}/result` — the raw NDJSON of a finished `rates.batch` job (free).
   * `parseNdjson()` splits it into rows.
   */
  async result(jobId: string, opts?: RequestOptions): Promise<string> {
    return this.vl._unwrap(
      this.vl.raw.GET("/v2/jobs/{job_id}/result", {
        params: { path: { job_id: jobId } },
        parseAs: "text",
        ...opts,
        headers: { Accept: "application/x-ndjson, application/json", ...opts?.headers },
      }) as Promise<FetchResult<string>>,
    );
  }

  /**
   * The NDJSON result of a succeeded job: from `result_url` when it is a signed
   * link elsewhere (fetched without the API key), otherwise from
   * `GET /v2/jobs/{id}/result` (also when `result_url` is null).
   */
  async download(job: Pick<Job, "job_id" | "result_url">, opts?: RequestOptions): Promise<string> {
    const url = job.result_url;
    if (!url || new URL(url, this.vl.baseUrl).origin === new URL(this.vl.baseUrl).origin) {
      return this.result(job.job_id, opts);
    }
    const res = await this.vl._fetch(new Request(url, { signal: opts?.signal, headers: opts?.headers }));
    if (!res.ok) {
      throw new VistaLinkError({ code: "upstream_error", message: `Downloading result_url failed (HTTP ${res.status})`, status: res.status });
    }
    return res.text();
  }

  /** `wait` then `download`: the NDJSON of a `rates.batch` job once it succeeds. */
  async waitForResult(jobId: string, opts: WaitOptions = {}): Promise<{ job: Job; ndjson: string }> {
    const job = await this.wait(jobId, { ...opts, throwOnFailure: true });
    return { job, ndjson: await this.download(job, { signal: opts.signal }) };
  }

  /** Poll `GET /v2/jobs/{id}` until `succeeded | failed | canceled`. */
  async wait(jobId: string, opts: WaitOptions = {}): Promise<Job> {
    const job = await this.vl._poll(() => this.get(jobId, { signal: opts.signal }), (j) => JOB_TERMINAL.has(j.status), opts, `job ${jobId}`);
    if (opts.throwOnFailure !== false && job.status !== "succeeded") {
      throw new VistaLinkError({
        code: job.status === "canceled" ? "job_canceled" : "job_failed",
        message: job.error?.message ?? `Job ${jobId} ${job.status}`,
        status: 0,
        requestId: job.request_id ?? null,
        details: { job_id: job.job_id, kind: job.kind, error: job.error ?? null },
      });
    }
    return job;
  }
}

export class WebhooksResource extends Resource {
  create(body: S["WebhookCreateRequest"], opts?: RequestOptions): Promise<S["WebhookCreated"]> {
    return this.vl._unwrap(this.vl.raw.POST("/v2/webhooks", { body, ...opts }));
  }

  list(opts?: RequestOptions): Promise<S["WebhookList"]> {
    return this.vl._unwrap(this.vl.raw.GET("/v2/webhooks", { ...opts }));
  }

  /** `DELETE /v2/webhooks/{id}` — 204, no body. */
  async delete(webhookId: string, opts?: RequestOptions): Promise<void> {
    await this.vl._unwrap(this.vl.raw.DELETE("/v2/webhooks/{webhook_id}", { params: { path: { webhook_id: webhookId } }, ...opts }));
  }

  deliveries(webhookId: string, query?: DeliveryListQuery, opts?: RequestOptions): Promise<S["WebhookDeliveryList"]> {
    return this.vl._unwrap(
      this.vl.raw.GET("/v2/webhooks/{webhook_id}/deliveries", { params: { path: { webhook_id: webhookId }, query }, ...opts }),
    );
  }

  /** Verify `X-VistaLink-Signature` over the raw body (5-minute tolerance) and return the parsed event. */
  verify<T = Record<string, unknown>>(
    secret: string,
    headers: HeadersLike,
    rawBody: string | Uint8Array | ArrayBuffer,
    opts?: VerifyOptions,
  ): Promise<WebhookEvent<T>> {
    return verifyWebhook<T>(secret, headers, rawBody, opts);
  }
}

export class ChatResource extends Resource {
  send(body: S["ChatRequest"], opts?: RequestOptions): Promise<S["ChatResponse"]> {
    return this.vl._unwrap(this.vl.raw.POST("/v2/chat", { body, ...opts }));
  }
}

export class CatalogResource extends Resource {
  amenities(opts?: RequestOptions): Promise<S["AmenityList"]> {
    return this.vl._unwrap(this.vl.raw.GET("/v2/amenities", { ...opts }));
  }

  engines(opts?: RequestOptions): Promise<S["EngineList"]> {
    return this.vl._unwrap(this.vl.raw.GET("/v2/engines", { ...opts }));
  }

  health(opts?: RequestOptions): Promise<S["Health"]> {
    return this.vl._unwrap(this.vl.raw.GET("/v2/health", { ...opts }));
  }

  /** `GET /v2/openapi.json` — this API's OpenAPI 3.1 document (public). */
  openapi(opts?: RequestOptions): Promise<Record<string, unknown>> {
    return this.vl._unwrap(this.vl.raw.GET("/v2/openapi.json", { ...opts }) as Promise<FetchResult<Record<string, unknown>>>);
  }
}
