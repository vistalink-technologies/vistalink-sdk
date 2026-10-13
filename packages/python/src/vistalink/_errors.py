from __future__ import annotations

from typing import Any, Mapping

_CODE_BY_STATUS = {
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
}


class VistaLinkError(Exception):
    """Every failure the client raises.

    ``code`` is the API's ``error.code`` (``bad_request``, ``unauthorized``,
    ``forbidden``, ``not_found``, ``conflict``, ``rate_limited``,
    ``insufficient_credit``, ``upstream_error``, ``unavailable``,
    ``not_implemented``, ``internal_error``) or a client-side code
    (``network_error``, ``timeout``, ``job_failed``, ``job_canceled``,
    ``invalid_response``). ``request_id`` is the API's ``request_id``.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 0,
        request_id: str | None = None,
        details: Mapping[str, Any] | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.request_id = request_id
        self.details: dict[str, Any] | None = dict(details) if details is not None else None
        self.retry_after = retry_after

    def __repr__(self) -> str:
        return (f"VistaLinkError(code={self.code!r}, status={self.status}, "
                f"request_id={self.request_id!r}, message={self.message!r})")

    @classmethod
    def from_response(cls, status: int, body: Any, headers: Mapping[str, str] | None = None) -> "VistaLinkError":
        from ._retry import parse_retry_after

        headers = headers or {}
        header_rid = headers.get("x-request-id")
        retry_after = parse_retry_after(headers.get("retry-after"))
        err = body.get("error") if isinstance(body, dict) else None
        if isinstance(err, dict) and isinstance(err.get("code"), str):
            return cls(
                err["code"],
                err.get("message") or f"HTTP {status}",
                status=status,
                request_id=err.get("request_id") or header_rid,
                details=err.get("details"),
                retry_after=retry_after,
            )
        if isinstance(body, dict) and isinstance(body.get("detail"), list):
            return cls("bad_request", "Request validation failed", status=status, request_id=header_rid,
                       details={"fields": body["detail"]})
        code = _CODE_BY_STATUS.get(status, "internal_error" if status >= 500 else "bad_request")
        message = body[:500] if isinstance(body, str) and body else f"HTTP {status}"
        return cls(code, message, status=status, request_id=header_rid, retry_after=retry_after)


class WebhookVerificationError(Exception):
    """A webhook delivery could not be verified."""
