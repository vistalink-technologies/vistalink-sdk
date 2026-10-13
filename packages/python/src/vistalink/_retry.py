from __future__ import annotations

import random
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime

RETRY_STATUSES = frozenset({429, 503})


@dataclass(frozen=True)
class RetryConfig:
    max_retries: int = 3
    base_delay: float = 0.5
    max_delay: float = 30.0


def parse_retry_after(value: str | None, now: float | None = None) -> float | None:
    """``Retry-After`` as delta-seconds or an HTTP date."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        at = parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError, IndexError):
        return None
    return max(0.0, at - (now if now is not None else time.time()))


def backoff_delay(attempt: int, cfg: RetryConfig, retry_after: float | None, rand=random.random) -> float:
    if retry_after is not None:
        return min(cfg.max_delay, retry_after)
    exp = min(cfg.max_delay, cfg.base_delay * (2 ** attempt))
    return exp / 2 + rand() * (exp / 2)
