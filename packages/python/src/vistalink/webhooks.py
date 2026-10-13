"""Webhook signature verification.

Contract: ``X-VistaLink-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>``,
checked with a 5-minute tolerance.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Mapping

from ._errors import WebhookVerificationError

SIGNATURE_HEADER = "X-VistaLink-Signature"
DEFAULT_TOLERANCE_SECONDS = 300


def compute_signature(secret: str, timestamp: int, body: bytes | str) -> str:
    raw = body.encode() if isinstance(body, str) else body
    return hmac.new(secret.encode(), f"{timestamp}.".encode() + raw, hashlib.sha256).hexdigest()


def sign(secret: str, body: bytes | str, timestamp: int | None = None) -> str:
    """Build a header value (useful to test your own endpoint)."""
    t = int(timestamp if timestamp is not None else time.time())
    return f"t={t},v1={compute_signature(secret, t, body)}"


def _header(headers: Mapping[str, Any] | str) -> str | None:
    if isinstance(headers, str):
        return headers
    for k, v in headers.items():
        if k.lower() == SIGNATURE_HEADER.lower():
            if isinstance(v, (list, tuple)):
                return v[0] if v else None
            return v
    return None


def parse_signature_header(value: str) -> tuple[int, list[str]]:
    t: int | None = None
    sigs: list[str] = []
    for part in value.split(","):
        k, sep, v = part.partition("=")
        if not sep:
            continue
        k, v = k.strip(), v.strip()
        if k == "t" and v.isdigit():
            t = int(v)
        elif k == "v1" and v:
            sigs.append(v.lower())
    if t is None or not sigs:
        raise WebhookVerificationError("Malformed X-VistaLink-Signature header")
    return t, sigs


def verify(
    secret: str,
    headers: Mapping[str, Any] | str,
    raw_body: bytes | str,
    *,
    tolerance: int = DEFAULT_TOLERANCE_SECONDS,
    now: int | None = None,
) -> dict[str, Any]:
    """Verify a delivery and return the parsed event ``{event, id, created_at, data}``.

    Pass the raw request body exactly as received. Raises
    :class:`WebhookVerificationError` on a missing/malformed header, a stale
    timestamp or a signature mismatch.
    """
    if not secret:
        raise WebhookVerificationError("Webhook secret is empty")
    value = _header(headers)
    if not value:
        raise WebhookVerificationError("Missing X-VistaLink-Signature header")
    t, sigs = parse_signature_header(value)
    current = int(now if now is not None else time.time())
    if abs(current - t) > tolerance:
        raise WebhookVerificationError("Signature timestamp is outside the tolerance window")
    expected = compute_signature(secret, t, raw_body)
    if not any(hmac.compare_digest(expected, s) for s in sigs):
        raise WebhookVerificationError("Signature mismatch")
    try:
        return json.loads(raw_body)
    except ValueError as exc:
        raise WebhookVerificationError("Signed body is not valid JSON") from exc
