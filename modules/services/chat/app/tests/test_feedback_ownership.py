"""`POST /chat/feedback` may only score a trace the caller owns (#1570).

The route used to require nothing but a valid JWT, then write
deterministic `{trace_id}:{name}` scores — which upsert — to whatever
trace id the body named. Guessing a stranger's client-minted UUIDv4 is
impractical, but spraying orphan scores into Langfuse was free. The turn
buffer already records the owner, so the check is the same one
`GET /chat/turn` makes.
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
    def __init__(self, records: dict[str, dict[str, Any]]) -> None:
        self.records = records

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return self.records.get(trace_id)


@pytest.fixture
def langfuse(monkeypatch: pytest.MonkeyPatch) -> _RecordingLangfuse:
    fake = _RecordingLangfuse()
    monkeypatch.setattr(feedback_module, "get_langfuse", lambda: fake)
    return fake


def _client(records: dict[str, dict[str, Any]]) -> TestClient:
    app = FastAPI()
    app.include_router(feedback_module.router)
    app.dependency_overrides[get_current_user] = lambda: _USER
    app.dependency_overrides[get_deps] = lambda: SimpleNamespace(
        rate_limiter=_AlwaysAllowLimiter(),
        turn_store=_FakeTurnStore(records),
    )
    return TestClient(app, raise_server_exceptions=False)


def _body(**over: Any) -> dict[str, Any]:
    return {"trace_id": _TRACE, "value": "up", **over}


def test_owner_can_score_their_turn(langfuse: _RecordingLangfuse) -> None:
    records = {_TRACE: {"state": "done", "user_id": _USER.id, "events": []}}

    r = _client(records).post("/chat/feedback", json=_body())

    assert r.status_code == 200
    assert [s["name"] for s in langfuse.scores] == ["user_feedback"]


def test_404_on_another_users_trace(langfuse: _RecordingLangfuse) -> None:
    records = {_TRACE: {"state": "done", "user_id": "user-2", "events": []}}

    r = _client(records).post("/chat/feedback", json=_body(value="down"))

    assert r.status_code == 404
    assert langfuse.scores == [], "must not upsert a score onto a foreign trace"


def test_404_on_unknown_trace(langfuse: _RecordingLangfuse) -> None:
    """The spray case: a trace id no turn ever used. Also the shape a
    Redis error takes, since the store returns None for both."""
    r = _client({}).post("/chat/feedback", json=_body())

    assert r.status_code == 404
    assert langfuse.scores == []
