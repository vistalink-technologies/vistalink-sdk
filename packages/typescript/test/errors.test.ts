import { describe, expect, it } from "vitest";
import { backoffDelay, DEFAULT_RETRY, parseRetryAfter } from "../src/index.js";

describe("parseRetryAfter", () => {
  it("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("garbage")).toBeNull();
    const now = Date.parse("2026-10-07T12:00:00Z");
    expect(parseRetryAfter("Wed, 07 Oct 2026 12:00:05 GMT", now)).toBe(5);
  });

  it("backoff caps Retry-After at maxDelayMs", () => {
    expect(backoffDelay(0, DEFAULT_RETRY, 120)).toBe(30_000);
    expect(backoffDelay(3, DEFAULT_RETRY, null, () => 1)).toBe(4000);
  });
});
