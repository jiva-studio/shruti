"""The Idempotency-Key must be released on any path that fails BEFORE
the SSE stream is handed off.

`api/chat.py` acquires the key up-front (so a duplicate doesn't burn the
user's quota) but the only `release()` lives in the stream generator's
`finally`. That generator never runs when the request is rejected
pre-stream — a 429 from the rate-limit gate, or any exception while
building the turn context. Without an explicit release on those paths the
client-minted key stays held for the full 600s TTL, so the user — who
just hit their quota or hit a transient error — gets 409 duplicate_request
for ten minutes on the same key. These tests pin the release.
"""

from __future__ import annotations

import pytest  # noqa: F401
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lectorium_chat.api import chat as chat_api
from lectorium_chat.api._auth import get_current_user
from lectorium_chat.application.rate_limiter import RateLimitResult
from lectorium_chat.composition import get_deps
from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser


class _FakeStore:
    """In-memory IdempotencyStore — same SET NX EX contract as Redis."""

    def __init__(self) -> None:
        self.held: set[str] = set()

    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        if key in self.held:
            return False
        self.held.add(key)
        return True

    async def release(self, key: str) -> None:
        self.held.discard(key)


class _DenyingRateLimiter:
    """Always rejects with a quota_exceeded result → handler raises 429."""

    async def check_and_increment(self, *args, **kwargs) -> RateLimitResult:
        return RateLimitResult(
            allowed=False,
            code="quota_exceeded",
            retry_after=60,
            current=10,
            limit=10,
            tier="free",
        )


class _ExplodingRateLimiter:
    """Raises before the stream is built → exercises the generic pre-stream
    exception path (stand-in for a UserContext/region failure)."""

    async def check_and_increment(self, *args, **kwargs) -> RateLimitResult:
        raise RuntimeError("boom before stream")


class _Deps:
    def __init__(self, rate_limiter, idempotency_store) -> None:
        self.rate_limiter = rate_limiter
        self.idempotency_store = idempotency_store


_USER = VerifiedUser(id="user-1", anonymous=False, tier="free")
_KEY = "idem-key-0001"
_REDIS_KEY = f"chat:{_USER.id}:{_KEY}"


def _client(deps: _Deps) -> TestClient:
    app = FastAPI()
    app.include_router(chat_api.router)
    app.dependency_overrides[get_current_user] = lambda: _USER
    app.dependency_overrides[get_deps] = lambda: deps
    return TestClient(app, raise_server_exceptions=False)


def _post(client: TestClient) -> "object":
    return client.post(
        "/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "lang": "en"},
        headers={
            "X-Chat-Protocol-Version": "1",
            "Idempotency-Key": _KEY,
        },
    )


def test_429_releases_idempotency_key() -> None:
    store = _FakeStore()
    client = _client(_Deps(_DenyingRateLimiter(), store))

    r = _post(client)

    assert r.status_code == 429
    # The acquired key must be freed so the user's next attempt (after the
    # quota resets / a retry) isn't 409-blocked for the full TTL.
    assert _REDIS_KEY not in store.held


def test_pre_stream_exception_releases_idempotency_key() -> None:
    store = _FakeStore()
    client = _client(_Deps(_ExplodingRateLimiter(), store))

    r = _post(client)

    assert r.status_code == 500
    assert _REDIS_KEY not in store.held


def test_acquire_happens_before_release_is_reachable() -> None:
    """Sanity: a duplicate in-flight key still 409s — the release fix must
    not weaken the dedup gate itself."""
    store = _FakeStore()
    store.held.add(_REDIS_KEY)  # simulate an in-flight duplicate
    client = _client(_Deps(_DenyingRateLimiter(), store))

    r = _post(client)

    assert r.status_code == 409
    # Still held: this request never acquired it, so it must not release a
    # sibling's key.
    assert _REDIS_KEY in store.held
