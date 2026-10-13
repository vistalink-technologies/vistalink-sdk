import { describe, expect, it } from "vitest";
import { VistaLink, WebhookVerificationError, signWebhook, verifyWebhook } from "../src/index.js";

// Vector produced by the API server's own webhook signer.
const SECRET = "whsec_test_123";
const BODY =
  '{"created_at":"2026-10-07T12:00:00Z","data":{"job_id":"job_abc","status":"succeeded"},"event":"rates.completed","id":"evt_1"}';
const T = 1791374400;
const HEADER = `t=${T},v1=48227c59b496d7b1365cb76b40bb17f7a055a21ea28b2865f511b336a7c36168`;

describe("webhooks.verify", () => {
  it("accepts the server's signature (Headers, plain object, raw string)", async () => {
    const vl = new VistaLink({ apiKey: "k" });
    const ev = await vl.webhooks.verify(SECRET, new Headers({ "X-VistaLink-Signature": HEADER }), BODY, { now: T + 10 });
    expect(ev.event).toBe("rates.completed");
    expect(ev.data).toEqual({ job_id: "job_abc", status: "succeeded" });
    await expect(verifyWebhook(SECRET, { "x-vistalink-signature": HEADER }, new TextEncoder().encode(BODY), { now: T })).resolves.toBeTruthy();
    await expect(verifyWebhook(SECRET, HEADER, BODY, { now: T })).resolves.toBeTruthy();
  });

  it("rejects a tampered body, wrong secret, and missing/malformed header", async () => {
    await expect(verifyWebhook(SECRET, HEADER, BODY.replace("succeeded", "failed"), { now: T })).rejects.toThrow("Signature mismatch");
    await expect(verifyWebhook("whsec_other", HEADER, BODY, { now: T })).rejects.toThrow(WebhookVerificationError);
    await expect(verifyWebhook(SECRET, {}, BODY, { now: T })).rejects.toThrow("Missing");
    await expect(verifyWebhook(SECRET, "v1=abc", BODY, { now: T })).rejects.toThrow("Malformed");
  });

  it("enforces the 5-minute tolerance both ways", async () => {
    await expect(verifyWebhook(SECRET, HEADER, BODY, { now: T + 300 })).resolves.toBeTruthy();
    await expect(verifyWebhook(SECRET, HEADER, BODY, { now: T + 301 })).rejects.toThrow("tolerance");
    await expect(verifyWebhook(SECRET, HEADER, BODY, { now: T - 301 })).rejects.toThrow("tolerance");
    await expect(verifyWebhook(SECRET, HEADER, BODY, { now: T + 1000, toleranceSeconds: 2000 })).resolves.toBeTruthy();
  });

  it("signWebhook round-trips and accepts any of several v1 values", async () => {
    const h = await signWebhook(SECRET, BODY, T);
    expect(h).toBe(HEADER);
    await expect(verifyWebhook(SECRET, `t=${T},v1=deadbeef,${h.split(",")[1]}`, BODY, { now: T })).resolves.toBeTruthy();
  });
});
