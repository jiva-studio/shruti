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
from datetime import datetime, timedelta, timezone

from lectorium_chat.config import Settings
from lectorium_chat.domain.ports.rate_limit_store import RateLimitStore
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


@dataclass
class RateLimitResult:
    allowed: bool
    code: str | None = None
    retry_after: int | None = None
    current: int = 0
    limit: int = 0
    key_type: str | None = None
    # ISO-8601 + UNIX-seconds form of the next reset boundary. Both
    # populated together; clients can pick whichever is easier to
    # format. Set only on the rejected (allowed=False) path — there's
    # no reason to mint these on every successful request.
    resets_at_iso: str | None = None
    resets_at_epoch: int | None = None
    # Subscription tier the limit was looked up under. Echoed in the
    # 429 body so the mobile UX can pick the right copy + CTA (anon →
    # "Войти", free → "Lectorium Pro", pro → "wait for reset").
    tier: str | None = None


def _seconds_until_midnight_utc() -> int:
    now = datetime.now(timezone.utc)
    return int(86400 - (now.hour * 3600 + now.minute * 60 + now.second))


def _next_midnight_utc(now: datetime | None = None) -> datetime:
    now = now or datetime.now(timezone.utc)
    base = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return base + timedelta(days=1)


class RateLimiter:
    """`scope` namespaces keys so /chat and /title don't share a bucket."""

    def __init__(self, *, store: RateLimitStore, settings: Settings) -> None:
        self._store = store
        self._settings = settings

    def _user_limit_for(self, scope: str, anonymous: bool, tier: str) -> int:
        """Three-way tier matrix. Anonymous trumps tier — an anonymous
        JWT can never carry a Pro entitlement (the OAuth identity that
        receipts the purchase doesn't exist yet). After signin RC's
        SUBSCRIBER_ALIAS event moves the entitlement to the new user_id
        and the next refresh issues a JWT with tier='pro'."""
        s = self._settings
        if scope == "title":
            anon, free, pro = s.title_anon_per_day, s.title_free_per_day, s.title_pro_per_day
        elif scope == "questions":
            anon, free, pro = s.questions_anon_per_day, s.questions_free_per_day, s.questions_pro_per_day
        elif scope == "feedback":
            anon, free, pro = s.feedback_anon_per_day, s.feedback_free_per_day, s.feedback_pro_per_day
        else:  # default → chat
            anon, free, pro = s.chat_anon_per_day, s.chat_free_per_day, s.chat_pro_per_day
        if anonymous:
            return anon
        if tier == "pro":
            return pro
        return free

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
        tier: str = "free",
    ) -> RateLimitResult:
        user_limit = self._user_limit_for(scope, anonymous, tier)
        ip_limit = self._ip_limit()
        now = datetime.now(timezone.utc)
        today = now.date()
        reset_at = _next_midnight_utc(now)
        # "anonymous" is more informative than tier="free" when anonymous=True
        # — the UI picks different copy.
        echoed_tier = "anonymous" if anonymous else tier

        def reject(rec, key_type: str) -> RateLimitResult:
            log.warning(
                "rate_limit_hit",
                scope=scope, user_id=user_id, anonymous=anonymous, tier=echoed_tier,
                key_type=key_type, current=rec.count, limit=rec.limit,
            )
            return RateLimitResult(
                allowed=False, code="rate_limited",
                retry_after=int((reset_at - now).total_seconds()),
                current=rec.count, limit=rec.limit, key_type=key_type,
                resets_at_iso=reset_at.isoformat().replace("+00:00", "Z"),
                resets_at_epoch=int(reset_at.timestamp()),
                tier=echoed_tier,
            )

        # Pass 1: per-user (the primary cap, JWT-derived). If they're over,
        # don't also blow the IP counter — that would let a single bad
        # actor poison CGNAT peers' quota.
        scoped_user_key = f"{scope}:user:{user_id}"
        rec = await self._store.increment(
            scoped_key=scoped_user_key, key_type="user", limit=user_limit, day=today,
        )
        if rec.count > rec.limit:
            return reject(rec, "user")

        # Pass 2: per-IP. Same table, distinct key namespace.
        scoped_ip_key = f"{scope}:ip:{ip}"
        rec = await self._store.increment(
            scoped_key=scoped_ip_key, key_type="ip", limit=ip_limit, day=today,
        )
        if rec.count > rec.limit:
            return reject(rec, "ip")

        return RateLimitResult(allowed=True)
