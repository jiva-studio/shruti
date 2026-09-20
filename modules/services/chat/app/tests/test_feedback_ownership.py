"""`POST /chat/feedback` may only score a trace the caller owns (#1570).

The route used to require nothing but a valid JWT, then write
deterministic `{trace_id}:{name}` scores — which upsert — to whatever
trace id the body named. Guessing a stranger's client-minted UUIDv4 is
impractical, but spraying orphan scores into Langfuse was free.

Ownership comes from the standalone `turn:<id>:owner` marker, NOT from
the turn record: that record carries the event buffer and expires after
24h, so authorising against it turned a thumbs-up on yesterday's message
into `chat.feedback.failed`. The marker holds only the user id and lives
on the far longer `turn_owner_ttl_s` horizon.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from lectorium_chat.api import feedback as feedback_module
from lectorium_chat.api._auth import get_current_user
from lectorium_chat.application.rate_limiter import RateLimitResult
from lectorium_chat.composition import get_deps
from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser

_USER = VerifiedUser(id="user-1", anonymous=False, tier="free")
_TRACE = "a" * 32


class _RecordingLangfuse:
    def __init__(self) -> None:
        self.scores: list[dict[str, Any]] = []

    def create_score(self, **kwargs: Any) -> None:
        self.scores.append(kwargs)


class _AlwaysAllowLimiter:
    async def check_and_increment(self, *a: Any, **kw: Any) -> RateLimitResult:
        return RateLimitResult(allowed=True)


class _FakeTurnStore:
    """Owner markers and event buffers expire on different horizons, so
    the fake keeps them apart. `records` left empty models the buffer
    having aged out while the marker survives."""

    def __init__(
        self,
        owners: dict[str, str],
        records: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.owners = owners
        self.records = records or {}
        self.gets: list[str] = []

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        self.gets.append(trace_id)
        return self.records.get(trace_id)

    async def get_owner(self, trace_id: str) -> str | None:
        return self.owners.get(trace_id)


@pytest.fixture
def langfuse(monkeypatch: pytest.MonkeyPatch) -> _RecordingLangfuse:
    fake = _RecordingLangfuse()
    monkeypatch.setattr(feedback_module, "get_langfuse", lambda: fake)
    return fake


def _client(store: _FakeTurnStore) -> TestClient:
    app = FastAPI()
    app.include_router(feedback_module.router)
    app.dependency_overrides[get_current_user] = lambda: _USER
    app.dependency_overrides[get_deps] = lambda: SimpleNamespace(
        rate_limiter=_AlwaysAllowLimiter(),
        turn_store=store,
    )
    return TestClient(app, raise_server_exceptions=False)


def _body(**over: Any) -> dict[str, Any]:
    return {"trace_id": _TRACE, "value": "up", **over}


def test_owner_can_score_their_turn(langfuse: _RecordingLangfuse) -> None:
    store = _FakeTurnStore(
        {_TRACE: _USER.id},
        {_TRACE: {"state": "done", "user_id": _USER.id, "events": []}},
    )

    r = _client(store).post("/chat/feedback", json=_body())

    assert r.status_code == 200
    assert [s["name"] for s in langfuse.scores] == ["user_feedback"]


def test_feedback_works_after_the_result_blob_expired(
    langfuse: _RecordingLangfuse,
) -> None:
    """The regression this marker exists for: rating a message older than
    `turn_result_ttl_s` (24h). The buffer is gone, the owner is not."""
    store = _FakeTurnStore({_TRACE: _USER.id})

    r = _client(store).post("/chat/feedback", json=_body(value="down"))

    assert r.status_code == 200
    assert "user_feedback" in [s["name"] for s in langfuse.scores]
    assert store.gets == [], "must not authorise against the 24h event buffer"


def test_404_on_another_users_trace(langfuse: _RecordingLangfuse) -> None:
    store = _FakeTurnStore({_TRACE: "user-2"})

    r = _client(store).post("/chat/feedback", json=_body(value="down"))

    assert r.status_code == 404
    assert langfuse.scores == [], "must not upsert a score onto a foreign trace"


def test_404_on_unknown_trace(langfuse: _RecordingLangfuse) -> None:
    """The spray case: a trace id no turn ever used. Fails CLOSED, and is
    the same shape a Redis error takes since the adapter returns None for
    both — acceptable only because the marker's TTL makes an honest miss
    a non-event."""
    r = _client(_FakeTurnStore({})).post("/chat/feedback", json=_body())

    assert r.status_code == 404
    assert langfuse.scores == []
