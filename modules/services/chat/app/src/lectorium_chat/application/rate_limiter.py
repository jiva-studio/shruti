"""Rate-limit use-case.

Day-bucketed per-(scope, user) and per-(scope, ip) throttle. JWT-based:
the key is the auth-issued `sub` claim. Anonymous JWTs get a tighter
quota than signed-in ones (the `anonymous` claim selects which limit).

Storage is plugged via `RateLimitStore` (Redis in prod). Endpoints call
`check_and_increment` directly — no module-level singleton.

When the backing store raises `RateLimitStoreUnavailable` the use-case
applies a tier-aware fallback policy (PR-1b):

- Pro tier → process-local LRU brownout counter so paying users keep
  serving through a Redis outage. Single-process only, so multiple
  replicas independently allow up to the limit each — accepted as a
  graceful-degradation trade-off, not exact enforcement.
- All other tiers (free, anonymous) → return a result with
  `backend_unavailable=True`, which the API layer translates into a
  503 response. Fail-closed prevents anonymous abuse traffic from
  slipping past enforcement during a Redis outage.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from lectorium_chat.config import Settings
from lectorium_chat.domain.ports.rate_limit_store import (
    CounterRecord,
    RateLimitStore,
    RateLimitStoreUnavailable,
)
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.observability.metrics import rate_limit_hits_counter
from lectorium_chat.observability.metrics import redis_unavailable_counter


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
    # PR-1b: Redis-store sentinel. When True the caller MUST raise 503
    # instead of 429 — the rate-limit decision is unknown, not denied.
    # Only ever set when the underlying store raises
    # `RateLimitStoreUnavailable` AND the tier policy is fail-closed.
    backend_unavailable: bool = False
    # Per-user counter AFTER the increment for THIS request. Populated
    # on both the allowed path and the reject path so the API layer can
    # emit a `usage` SSE event (chat composer chip) without re-querying
    # the store. Captured from pass-1 (user-key) BEFORE pass-2 (per-IP)
    # clobbers `rec`.
    current_after: int = 0
    # The per-user scope limit the request was checked against. Mirrors
    # `_user_limit_for(...)` output (tier-resolved, anonymous override,
    # stale-pro coercion already applied).
    limit_for_scope: int = 0


@dataclass
class _LocalCounter:
    """One entry in the brownout LRU. Window-based, mirrors the Redis
    day-bucket semantics: when `now - window_start > window` the count
    resets implicitly on the next increment."""

    count: int
    window_start: float


class _BrownoutCounter:
    """Process-local LRU counter used only when Redis is unavailable
    AND the tier is `pro` (brownout instead of fail-closed).

    Single-process only — multiple replicas all independently allow up
    to the limit. The goal is rough cost containment during outages,
    not exact enforcement. LRU cap prevents memory growth if the outage
    is long and the key space is large.
    """

    def __init__(self, *, max_entries: int = 10_000, window_seconds: int = 86_400):
        self._lock = threading.Lock()
        self._entries: OrderedDict[str, _LocalCounter] = OrderedDict()
        self._max = max_entries
        self._window = window_seconds

    def increment(self, key: str, *, key_type: str, limit: int) -> CounterRecord:
        with self._lock:
            now = time.time()
            rec = self._entries.get(key)
            if rec is None or (now - rec.window_start) > self._window:
                rec = _LocalCounter(count=0, window_start=now)
            rec.count += 1
            self._entries[key] = rec
            self._entries.move_to_end(key)
            while len(self._entries) > self._max:
                self._entries.popitem(last=False)
            return CounterRecord(key_type=key_type, count=rec.count, limit=limit)


# Module-level singleton — shared across all RateLimiter instances in
# this process. Survives RateLimiter rebuilds (no use-case state should
# live on the limiter; the counter belongs to the process).
_local_brownout_counter = _BrownoutCounter()


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

    async def store_healthy(self) -> bool:
        """Readiness probe: is the backing store reachable? Delegates to
        the store's `ping` when it has one (the Redis adapter), else
        reports healthy — an in-memory / fake store has no external
        service to be down. Used by `/readyz`; the rate-limit store is
        mandatory in prod, so a dead backend must fail readiness."""
        ping = getattr(self._store, "ping", None)
        if ping is None:
            return True
        return bool(await ping())

    def _user_limit_for(
        self,
        scope: str,
        anonymous: bool,
        tier: str,
        tier_expires_at: int = 0,
    ) -> int:
        """Resolve the per-user daily limit for `scope`.

        For `chat`, retains the three-way tier matrix (anon / free / pro).
        For the cheap non-chat scopes (`title`, `questions`, `feedback`,
        `turn_cancel`)
        the tier split was de-facto unused — the previous per-tier caps
        differed only by an order of magnitude on already-tiny call
        counts — so they collapse to ONE flat number. Same value for
        anonymous, free, and Pro users; saves three knobs each.

        Anonymous trumps tier — an anonymous JWT can never carry a Pro
        entitlement (the OAuth identity that receipts the purchase
        doesn't exist yet). After signin RC's SUBSCRIBER_ALIAS event
        moves the entitlement to the new user_id and the next refresh
        issues a JWT with tier='pro'.

        `tier_expires_at` is the UNIX-epoch claim minted by auth. 0 means
        lifetime / free (no expiry concept) — never coerce. A non-zero
        value in the past means the auth-side `tier="pro"` is stale (a
        dropped EXPIRATION webhook); we fall back to free limits without
        waiting for the next reconcile cycle to repair the column."""
        s = self._settings
        if scope == "title":
            return s.title_per_day
        if scope == "questions":
            return s.questions_per_day
        if scope == "feedback":
            return s.feedback_per_day
        if scope == "turn_cancel":
            return s.turn_cancel_per_day
        # chat → three-way tier matrix
        anon, free, pro = s.chat_anon_per_day, s.chat_free_per_day, s.chat_pro_per_day
        if anonymous:
            return anon
        if tier == "pro":
            if tier_expires_at != 0 and tier_expires_at < int(time.time()):
                # Stale Pro claim — refuse to honour it past the real expiry.
                return free
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
        quota_id: str = "",
        tier_expires_at: int = 0,
    ) -> RateLimitResult:
        user_limit = self._user_limit_for(scope, anonymous, tier, tier_expires_at)
        ip_limit = self._ip_limit()
        now = datetime.now(timezone.utc)
        today = now.date()
        reset_at = _next_midnight_utc(now)
        # "anonymous" is more informative than tier="free" when anonymous=True
        # — the UI picks different copy. If we just downgraded a stale Pro to
        # free limits, the echoed tier must reflect that — the mobile UX
        # uses it to pick the right CTA copy.
        effective_tier = tier
        if (
            not anonymous
            and tier == "pro"
            and tier_expires_at != 0
            and tier_expires_at < int(time.time())
        ):
            effective_tier = "free"
        echoed_tier = "anonymous" if anonymous else effective_tier
        # Per-user key: quota_id (stable across delete+recreate via the
        # OAuth identity hash) when present; falls back to user_id for
        # anonymous users (no OAuth identity yet) and for old in-flight
        # tokens that lack the claim. See issue #626.
        user_key = quota_id or user_id

        def reject(rec, key_type: str) -> RateLimitResult:
            # Structured log with `ip` so grepping aggregated logs can
            # spot CGNAT peer storms (same ip, many user_ids) vs a
            # single hammering user (one user_id, growing count).
            log.warning(
                "rate_limit_hit",
                scope=scope, user_id=user_id, anonymous=anonymous, tier=echoed_tier,
                key_type=key_type, current=rec.count, limit=rec.limit,
                ip=ip,
            )
            # Prometheus counter — bounded cardinality on labels so it
            # stays cheap. Scraped from the obs host via metrics-proxy
            # (infra/observability-agent) — chat publishes no host port,
            # so nothing reaches /metrics without that hop.
            try:
                rate_limit_hits_counter.labels(
                    scope=scope, key_type=key_type, tier=echoed_tier,
                ).inc()
            except Exception as exc:  # noqa: BLE001 — metric never breaks turn
                log.warning("rate_limit_metric_emit_failed", error=str(exc))
            return RateLimitResult(
                allowed=False, code="rate_limited",
                retry_after=int((reset_at - now).total_seconds()),
                current=rec.count, limit=rec.limit, key_type=key_type,
                resets_at_iso=reset_at.isoformat().replace("+00:00", "Z"),
                resets_at_epoch=int(reset_at.timestamp()),
                tier=echoed_tier,
                # Mirror the per-user counter on the user-key reject path
                # so the API layer can hydrate the chat usage chip from
                # the 429 body without a separate read. On an IP-key
                # reject we pass through the pass-1 snapshot captured
                # below (the per-user counter from this very request).
                current_after=rec.count if key_type == "user" else user_current_after,
                limit_for_scope=user_limit,
            )

        # Pass 1: per-user (the primary cap, JWT-derived). If they're over,
        # don't also blow the IP counter — that would let a single bad
        # actor poison CGNAT peers' quota.
        scoped_user_key = f"{scope}:user:{user_key}"
        try:
            rec = await self._store.increment(
                scoped_key=scoped_user_key, key_type="user", limit=user_limit, day=today,
            )
        except RateLimitStoreUnavailable:
            return self._on_backend_unavailable(
                scoped_key=scoped_user_key, key_type="user",
                limit=user_limit, echoed_tier=echoed_tier, tier=tier,
            )
        # Snapshot the per-user counter BEFORE pass-2 clobbers `rec` —
        # the chat usage chip + IP-key reject path both want this
        # number, not whatever the per-IP increment landed on.
        user_current_after = rec.count
        if rec.count > rec.limit:
            return reject(rec, "user")

        # Pass 2: per-IP. Anonymous only — the per-IP cap exists as a
        # defence against anon-JWT-spam from one IP (a bot script
        # minting throwaway anon tokens to bypass the per-user cap).
        # For signed-in users the per-user cap (200/day Pro, 10/day
        # free, keyed by quota_id) already bottles them; layering a
        # per-IP cap on top punishes CGNAT peers — e.g. 10 Pro users
        # on one Yota/Tele2 IP collectively trip 2000/day even when
        # each is well under their personal 200. Edge Caddy still
        # carries a loose 1000/hour per-IP fence for raw DoS.
        if anonymous:
            scoped_ip_key = f"{scope}:ip:{ip}"
            try:
                rec = await self._store.increment(
                    scoped_key=scoped_ip_key, key_type="ip", limit=ip_limit, day=today,
                )
            except RateLimitStoreUnavailable:
                # The per-user counter (pass-1) already charged this request,
                # but the IP check can't run — give the user-unit back before
                # surfacing the outage so a fail-closed 503 doesn't silently
                # consume quota. Best-effort: a second outage on the decrement
                # is swallowed (same window resets it).
                try:
                    await self._store.decrement(scoped_key=scoped_user_key, day=today)
                except RateLimitStoreUnavailable:
                    log.warning(
                        "rate_limit_user_refund_on_ip_reject_failed",
                        scope=scope, key_type="user",
                    )
                return self._on_backend_unavailable(
                    scoped_key=scoped_ip_key, key_type="ip",
                    limit=ip_limit, echoed_tier=echoed_tier, tier=tier,
                )
            if rec.count > rec.limit:
                # The per-IP cap rejects, but pass-1 already charged the
                # per-user bucket. Without giving it back, an IP-throttled
                # anonymous user permanently loses a user-quota unit per
                # blocked attempt (and the usage chip over-counts). Refund
                # the user unit before returning the IP reject; best-effort,
                # mirroring `refund()`.
                try:
                    refunded = await self._store.decrement(
                        scoped_key=scoped_user_key, day=today,
                    )
                    # Reflect the refund in the chip snapshot the IP-reject
                    # path echoes (`current_after`), so the client doesn't
                    # show a unit it didn't actually consume.
                    if refunded is not None:
                        user_current_after = refunded
                except RateLimitStoreUnavailable:
                    log.warning(
                        "rate_limit_user_refund_on_ip_reject_failed",
                        scope=scope, key_type="user",
                    )
                return reject(rec, "ip")

        return RateLimitResult(
            allowed=True,
            current_after=user_current_after,
            limit_for_scope=user_limit,
        )

    async def refund(
        self,
        user_id: str,
        anonymous: bool,
        ip: str,
        *,
        scope: str = "chat",
        quota_id: str = "",
    ) -> int | None:
        """Give back the unit(s) `check_and_increment` charged for a turn
        that then failed before delivering an answer (LLM out of credits,
        graph crash). Mirrors the keys the admit path incremented: always
        the per-user bucket, plus the per-IP bucket for anonymous callers
        (signed-in users are never IP-counted — see `check_and_increment`).

        Best-effort: a Redis outage during the refund is swallowed (the
        turn already failed; we won't also fail the response over a
        bookkeeping decrement). Returns the per-user bucket's count after
        the refund so the caller can render an accurate usage chip, or
        `None` if the user-bucket decrement couldn't be applied.

        Note: a brownout-counted Pro increment (Redis was down at admit
        time) is not refunded — the same outage makes this decrement fail
        too. Acceptable: it's a double-degraded edge (outage + turn
        failure) and the brownout counter resets at the daily window."""
        today = datetime.now(timezone.utc).date()
        user_key = quota_id or user_id
        user_count: int | None = None
        try:
            user_count = await self._store.decrement(
                scoped_key=f"{scope}:user:{user_key}", day=today,
            )
        except RateLimitStoreUnavailable:
            log.warning("rate_limit_refund_failed", scope=scope, key_type="user")
        if anonymous:
            try:
                await self._store.decrement(
                    scoped_key=f"{scope}:ip:{ip}", day=today,
                )
            except RateLimitStoreUnavailable:
                log.warning("rate_limit_refund_failed", scope=scope, key_type="ip")
        return user_count

    def _on_backend_unavailable(
        self,
        *,
        scoped_key: str,
        key_type: str,
        limit: int,
        echoed_tier: str,
        tier: str,
    ) -> RateLimitResult:
        """Tier-aware Redis-outage fallback.

        - `pro` → brownout: count against the process-local LRU; if the
          local count exceeds the limit return a normal 429 result so
          the existing 429 envelope translates it. Otherwise return
          `allowed=True`.
        - everything else → fail-closed: return a result flagged
          `backend_unavailable=True`. The API layer surfaces this as a
          503; the caller treats Redis being down as "unknown decision"
          rather than "approved".
        """
        redis_unavailable_counter.labels(tier=echoed_tier).inc()
        if tier == "pro":
            rec = _local_brownout_counter.increment(
                scoped_key, key_type=key_type, limit=limit,
            )
            log.warning(
                "rate_limit_brownout",
                tier=echoed_tier, key=scoped_key,
                current=rec.count, limit=rec.limit,
            )
            if rec.count > rec.limit:
                now = datetime.now(timezone.utc)
                reset_at = _next_midnight_utc(now)
                return RateLimitResult(
                    allowed=False, code="rate_limited",
                    retry_after=int((reset_at - now).total_seconds()),
                    current=rec.count, limit=rec.limit, key_type=key_type,
                    resets_at_iso=reset_at.isoformat().replace("+00:00", "Z"),
                    resets_at_epoch=int(reset_at.timestamp()),
                    tier=echoed_tier,
                    current_after=rec.count,
                    limit_for_scope=limit,
                )
            return RateLimitResult(
                allowed=True,
                tier=echoed_tier,
                # Brownout-local counter is best-effort (single-process,
                # no shared truth across replicas) but still gives the
                # client a reasonable progress number for the usage chip.
                current_after=rec.count,
                limit_for_scope=limit,
            )
        # Non-Pro: fail-closed.
        log.warning(
            "rate_limit_fail_closed", tier=echoed_tier, key=scoped_key,
        )
        return RateLimitResult(
            allowed=False,
            code="rate_limit_backend_unavailable",
            tier=echoed_tier,
            key_type=key_type,
            backend_unavailable=True,
        )
