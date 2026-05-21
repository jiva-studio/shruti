"""Rate-limit use-case.

Owns the day-bucketed-per-key throttle policy. Storage is plugged in
via `RateLimitStore`; the limits come from settings. Endpoints call
`check_and_increment` directly — no module-level singleton.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from shruti_chat.config import Settings
from shruti_chat.domain.ports.rate_limit_store import RateLimitStore
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


@dataclass
class RateLimitResult:
    allowed: bool
    code: str | None = None
    retry_after: int | None = None
    current: int = 0
    limit: int = 0
    key_type: str | None = None


def _seconds_until_midnight_utc() -> int:
    now = datetime.now(timezone.utc)
    return int(86400 - (now.hour * 3600 + now.minute * 60 + now.second))


class RateLimiter:
    """`scope` namespaces keys so /chat and /title don't share a bucket."""

    def __init__(self, *, store: RateLimitStore, settings: Settings) -> None:
        self._store = store
        self._settings = settings

    def _limits_for(self, scope: str) -> tuple[int, int]:
        s = self._settings
        if scope == "title":
            return s.title_device_rate_limit_per_day, s.title_ip_rate_limit_per_day
        if scope == "questions":
            return s.questions_device_rate_limit_per_day, s.questions_ip_rate_limit_per_day
        return s.device_rate_limit_per_day, s.ip_rate_limit_per_day

    async def check_and_increment(
        self,
        device_id: str,
        ip: str,
        *,
        scope: str = "chat",
    ) -> RateLimitResult:
        device_limit, ip_limit = self._limits_for(scope)
        today = datetime.now(timezone.utc).date()
        for key, key_type, limit in (
            (device_id, "device", device_limit),
            (ip, "ip", ip_limit),
        ):
            if not key:
                continue
            scoped_key = f"{scope}:{key}"
            record = await self._store.increment(
                scoped_key=scoped_key, key_type=key_type, limit=limit, day=today,
            )
            if record.count > record.limit:
                log.warning(
                    "rate_limit_hit",
                    scope=scope,
                    device_id=device_id,
                    key_type=record.key_type,
                    current=record.count,
                    limit=record.limit,
                )
                return RateLimitResult(
                    allowed=False,
                    code="rate_limited",
                    retry_after=_seconds_until_midnight_utc(),
                    current=record.count,
                    limit=record.limit,
                    key_type=record.key_type,
                )
        return RateLimitResult(allowed=True)
