import { WebhookVerificationError } from "./errors.js";

/** Contract: `X-VistaLink-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>`. */
export const SIGNATURE_HEADER = "x-vistalink-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookEventName =
  | "rates.completed"
  | "rates.batch.completed"
  | "rooms.reconcile.completed"
  | "booking.updated"
  | "quote.updated"
  | (string & {});

export interface WebhookEvent<T = Record<string, unknown>> {
  event: WebhookEventName;
  id: string;
  created_at: string;
  data: T;
}

export type HeadersLike = Headers | Record<string, string | string[] | undefined> | string;

export interface VerifyOptions {
  /** Seconds the timestamp may differ from now. Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Override "now" (unix seconds), for tests. */
  now?: number;
}

function headerValue(headers: HeadersLike): string | null {
  if (typeof headers === "string") return headers;
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(SIGNATURE_HEADER);
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === SIGNATURE_HEADER) return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  }
  return null;
}

function toBytes(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body instanceof Uint8Array ? body : new Uint8Array(body);
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function parseSignatureHeader(value: string): { t: number; v1: string[] } {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of value.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) v1.push(v.toLowerCase());
  }
  if (t === null || v1.length === 0) throw new WebhookVerificationError("Malformed X-VistaLink-Signature header");
  return { t, v1 };
}

/** hex HMAC-SHA256(secret, "<t>.<body>") using WebCrypto (Node 20+, browsers, workers). */
export async function computeSignature(secret: string, timestamp: number, body: string | Uint8Array | ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new WebhookVerificationError("WebCrypto (crypto.subtle) is not available in this runtime");
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = enc.encode(`${timestamp}.`);
  const bytes = toBytes(body);
  const msg = new Uint8Array(prefix.length + bytes.length);
  msg.set(prefix, 0);
  msg.set(bytes, prefix.length);
  return hex(await subtle.sign("HMAC", key, msg));
}

/** Build a header value, e.g. to test your own endpoint. */
export async function signWebhook(secret: string, body: string | Uint8Array, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${await computeSignature(secret, timestamp, body)}`;
}

/**
 * Verify a webhook delivery and return the parsed event. Pass the RAW body
 * bytes/string exactly as received (not re-serialised JSON).
 * Throws `WebhookVerificationError` on a missing/malformed header, a stale
 * timestamp (outside the tolerance) or a signature mismatch.
 */
export async function verifyWebhook<T = Record<string, unknown>>(
  secret: string,
  headers: HeadersLike,
  rawBody: string | Uint8Array | ArrayBuffer,
  opts: VerifyOptions = {},
): Promise<WebhookEvent<T>> {
  if (!secret) throw new WebhookVerificationError("Webhook secret is empty");
  const value = headerValue(headers);
  if (!value) throw new WebhookVerificationError("Missing X-VistaLink-Signature header");
  const { t, v1 } = parseSignatureHeader(value);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) throw new WebhookVerificationError("Signature timestamp is outside the tolerance window");
  const expected = await computeSignature(secret, t, rawBody);
  if (!v1.some((sig) => timingSafeEqualHex(expected, sig))) throw new WebhookVerificationError("Signature mismatch");
  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(toBytes(rawBody));
  try {
    return JSON.parse(text) as WebhookEvent<T>;
  } catch {
    throw new WebhookVerificationError("Signed body is not valid JSON");
  }
}
