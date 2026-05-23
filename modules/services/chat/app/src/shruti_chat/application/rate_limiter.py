"""Rate-limit use-case.

Day-bucketed per-(scope, user) and per-(scope, ip) throttle. JWT-based:
the key is the auth-issued `sub` claim. Anonymous JWTs get a tighter
quota than signed-in ones (the `anonymous` claim selects which limit).

Storage is plugged via `RateLimitStore` (postgres `usage` table in
prod). Endpoints call `check_and_increment` directly — no module-level
singleton.
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

    def _user_limit_for(self, scope: str, anonymous: bool) -> int:
        s = self._settings
        if scope == "title":
            return s.title_anon_per_day if anonymous else s.title_signed_in_per_day
        if scope == "questions":
            return s.questions_anon_per_day if anonymous else s.questions_signed_in_per_day
        if scope == "feedback":
            return s.feedback_anon_per_day if anonymous else s.feedback_signed_in_per_day
        # default → chat
        return s.chat_anon_per_day if anonymous else s.chat_signed_in_per_day

    def _ip_limit(self) -> int:
        # IP limit is uniform across scopes — it's defence-in-depth on top
        # of the per-user cap. Scope-aware per-IP limits weren't moving any
        # metric in the old setup so they're rolled into one.
        return self._settings.ip_rate_limit_per_day

    async def check_and_increment(
        self,
        user_id: str,
        anonymous: bool,
        ip: str,
        *,
        scope: str = "chat",
    ) -> RateLimitResult:
        user_limit = self._user_limit_for(scope, anonymous)
        ip_limit = self._ip_limit()
        today = datetime.now(timezone.utc).date()

        # Pass 1: per-user (the primary cap, JWT-derived). If they're over,
        # don't also blow the IP counter — that would let a single bad
        # actor poison CGNAT peers' quota.
        scoped_user_key = f"{scope}:user:{user_id}"
        rec = await self._store.increment(
            scoped_key=scoped_user_key, key_type="user", limit=user_limit, day=today,
        )
        if rec.count > rec.limit:
            log.warning(
                "rate_limit_hit",
                scope=scope, user_id=user_id, anonymous=anonymous,
                key_type="user", current=rec.count, limit=rec.limit,
            )
            return RateLimitResult(
                allowed=False, code="rate_limited",
                retry_after=_seconds_until_midnight_utc(),
                current=rec.count, limit=rec.limit, key_type="user",
            )

        # Pass 2: per-IP. Same table, distinct key namespace.
        scoped_ip_key = f"{scope}:ip:{ip}"
        rec = await self._store.increment(
            scoped_key=scoped_ip_key, key_type="ip", limit=ip_limit, day=today,
        )
        if rec.count > rec.limit:
            log.warning(
                "rate_limit_hit",
                scope=scope, ip=ip,
                key_type="ip", current=rec.count, limit=rec.limit,
            )
            return RateLimitResult(
                allowed=False, code="rate_limited",
                retry_after=_seconds_until_midnight_utc(),
                current=rec.count, limit=rec.limit, key_type="ip",
            )

        return RateLimitResult(allowed=True)
