/** Error codes the API returns in `error.code`, plus the client-side ones. */
export type VistaLinkErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "insufficient_credit"
  | "upstream_error"
  | "unavailable"
  | "not_implemented"
  | "internal_error"
  // client-side
  | "network_error"
  | "timeout"
  | "job_failed"
  | "job_canceled"
  | "invalid_response"
  | (string & {});

const CODE_BY_STATUS: Record<number, VistaLinkErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  402: "insufficient_credit",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "bad_request",
  429: "rate_limited",
  501: "not_implemented",
  502: "upstream_error",
  503: "unavailable",
};

export interface VistaLinkErrorInit {
  code: VistaLinkErrorCode;
  message: string;
  status: number;
  requestId?: string | null;
  details?: Record<string, unknown> | null;
  retryAfterSeconds?: number | null;
  cause?: unknown;
}

/**
 * Every failure the client surfaces. `requestId` is the API's `request_id`
 * (also sent as `X-Request-Id`); quote it when contacting support.
 */
export class VistaLinkError extends Error {
  readonly code: VistaLinkErrorCode;
  readonly status: number;
  readonly requestId: string | null;
  readonly details: Record<string, unknown> | null;
  readonly retryAfterSeconds: number | null;

  constructor(init: VistaLinkErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "VistaLinkError";
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId ?? null;
    this.details = init.details ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }

  /** Build from a non-2xx response body (v2 envelope, FastAPI 422, or anything else). */
  static fromResponse(status: number, body: unknown, headers?: Headers): VistaLinkError {
    const headerRid = headers?.get("x-request-id") ?? null;
    const retryAfter = parseRetryAfter(headers?.get("retry-after") ?? null);
    const env = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const err = env && typeof env.error === "object" && env.error ? (env.error as Record<string, unknown>) : null;
    if (err && typeof err.code === "string") {
      return new VistaLinkError({
        code: err.code,
        message: typeof err.message === "string" ? err.message : `HTTP ${status}`,
        status,
        requestId: (typeof err.request_id === "string" ? err.request_id : null) ?? headerRid,
        details: (err.details as Record<string, unknown> | null | undefined) ?? null,
        retryAfterSeconds: retryAfter,
      });
    }
    if (env && Array.isArray(env.detail)) {
      // FastAPI's default validation shape; the v2 router normally converts it.
      return new VistaLinkError({
        code: "bad_request",
        message: "Request validation failed",
        status,
        requestId: headerRid,
        details: { fields: env.detail },
      });
    }
    return new VistaLinkError({
      code: CODE_BY_STATUS[status] ?? (status >= 500 ? "internal_error" : "bad_request"),
      message: typeof body === "string" && body ? body.slice(0, 500) : `HTTP ${status}`,
      status,
      requestId: headerRid,
      retryAfterSeconds: retryAfter,
    });
  }
}

/** Thrown by `webhooks.verify` when a delivery cannot be trusted. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, (at - now) / 1000);
}
