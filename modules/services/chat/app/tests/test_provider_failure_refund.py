"""Turn-lifecycle correctness: a turn that fails or is cancelled must
refund the charged quota unit AND release its idempotency key — never
charge the user for an answer that was never delivered.

Three failure shapes are covered against the real POST /chat handler +
TurnRunner (same harness as test_chat_help_quota_refund):

  1. Mid-turn provider failure (an `error` event) on a NON-help intent →
     finalize calls refund() exactly once and the idempotency key becomes
     re-acquirable.
  2. A turn cancelled mid-flight (asyncio.CancelledError, e.g. shutdown /
     explicit Stop) → same refund + key release, and the store records
     state="cancelled".

A second group exercises the request-handshake guards directly against a
FastAPI TestClient: the 426 protocol-version handshake and the 400s for a
malformed Idempotency-Key and an invalid trace id.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from fastapi import Request

from shruti_chat.api import chat as chat_api
from shruti_chat.api.chat import chat
from shruti_chat.api._auth import get_current_user
from shruti_chat.api.schemas.chat import ChatRequestDto
from shruti_chat.application.turn_runner import TurnRunner
from shruti_chat.composition import get_deps
from shruti_chat.infra.auth.jwt_verifier import VerifiedUser


class _FakeAgentEvent:
    def __init__(self, type_: str, data: dict[str, Any]) -> None:
        self.type = type_
        self.data = data


class _FakeTurnStore:
    def __init__(self) -> None:
        self.finished: dict[str, dict[str, Any]] = {}

    async def mark_running(self, trace_id: str, user_id: str) -> None:
        return None

    async def heartbeat(self, trace_id: str) -> None:
        return None

    async def finish(self, trace_id: str, *, state: str, events: list, user_id: str) -> None:
        self.finished[trace_id] = {"state": state, "user_id": user_id, "events": events}

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return self.finished.get(trace_id)

    async def request_cancel(self, trace_id: str) -> None:
        return None

    async def is_cancelled(self, trace_id: str) -> bool:
        return False


class _RecordingRateLimiter:
    def __init__(self) -> None:
        self.refund_calls = 0

    async def check_and_increment(self, *args, **kwargs):
        return SimpleNamespace(allowed=True, current_after=5, limit_for_scope=10)

    async def refund(self, *args, **kwargs):
        self.refund_calls += 1
        return 4


class _FakeIdempotency:
    """In-memory SET-NX-EX store — `try_acquire` is single-shot until
    `release`, so re-acquirability after a failed turn is observable."""

    def __init__(self) -> None:
        self.held: set[str] = set()

    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        if key in self.held:
            return False
        self.held.add(key)
        return True

    async def release(self, key: str) -> None:
        self.held.discard(key)


class _Deps:
    def __init__(self, store: _FakeTurnStore, limiter: _RecordingRateLimiter,
                 idem: _FakeIdempotency) -> None:
        self.turn_store = store
        self.turn_runner = TurnRunner(store)
        self.rate_limiter = limiter
        self.idempotency_store = idem


_USER = VerifiedUser(id="user-1", anonymous=False, tier="free")
_TRACE = "b" * 32
_KEY = "idem-key-0001"
_REDIS_KEY = f"chat:{_USER.id}:{_KEY}"


def _make_request() -> Request:
    return Request(
        {"type": "http", "method": "POST", "path": "/chat", "headers": [],
         "client": ("127.0.0.1", 0)}
    )


def _body() -> ChatRequestDto:
    return ChatRequestDto.model_validate(
        {"messages": [{"role": "user", "content": "tell me about karma"}], "lang": "en"}
    )


async def _wait(predicate, tries: int = 200) -> None:
    for _ in range(tries):
        if predicate():
            return
        await asyncio.sleep(0.02)


def _has_usage_refund(events: list[dict[str, Any]]) -> int:
    frame = next(e for e in events if e["event"] == "usage")
    return json.loads(frame["data"])["current"]


# ── 1. mid-turn provider failure refunds + releases key ────────────────


def _failing_stream():
    async def _fake_stream(*_args, **_kwargs):
        # Router classifies a normal (non-exempt) intent, then the provider
        # fails mid-turn — exactly the shape chat_turn yields when
        # is_provider_unavailable maps an OpenRouter outage.
        yield _FakeAgentEvent(
            "status", {"key": "router_decision", "params": {"intent": "research"}}
        )
        yield _FakeAgentEvent(
            "error", {"code": "chat_unavailable", "message": "provider down"}
        )

    return _fake_stream


@pytest.mark.asyncio
async def test_provider_failure_refunds_and_releases_key(monkeypatch) -> None:
    monkeypatch.setattr(
        chat_api, "run_chat_turn", lambda *a, **k: _failing_stream()()
    )
    store = _FakeTurnStore()
    limiter = _RecordingRateLimiter()
    idem = _FakeIdempotency()
    deps = _Deps(store, limiter, idem)

    resp = await chat(
        _make_request(), _body(),
        x_chat_protocol_version="1", idempotency_key=_KEY, x_trace_id=_TRACE,
        user=_USER, deps=deps,
    )
    assert resp.status_code == 200
    await _wait(lambda: _TRACE in store.finished)
    finished = store.finished[_TRACE]

    # Failed turn → error state, refunded exactly once.
    assert finished["state"] == "error"
    assert limiter.refund_calls == 1
    assert _has_usage_refund(finished["events"]) == 4
    # The idempotency key is freed so the user's retry isn't 409-blocked.
    assert _REDIS_KEY not in idem.held
    assert await idem.try_acquire(_REDIS_KEY, 600) is True


# ── 2. cancellation refunds + releases key + state=cancelled ───────────


def _slow_stream(started: asyncio.Event):
    async def _fake_stream(*_args, **_kwargs):
        yield _FakeAgentEvent(
            "status", {"key": "router_decision", "params": {"intent": "research"}}
        )
        started.set()
        # Hang so the test can cancel the producer mid-flight.
        await asyncio.sleep(3600)
        yield _FakeAgentEvent("done", {})

    return _fake_stream


@pytest.mark.asyncio
async def test_cancelled_turn_refunds_and_releases_key(monkeypatch) -> None:
    started = asyncio.Event()
    monkeypatch.setattr(
        chat_api, "run_chat_turn", lambda *a, **k: _slow_stream(started)()
    )
    store = _FakeTurnStore()
    limiter = _RecordingRateLimiter()
    idem = _FakeIdempotency()
    deps = _Deps(store, limiter, idem)

    resp = await chat(
        _make_request(), _body(),
        x_chat_protocol_version="1", idempotency_key=_KEY, x_trace_id=_TRACE,
        user=_USER, deps=deps,
    )
    assert resp.status_code == 200

    # Wait until the producer is mid-stream, then cancel its task (mirrors
    # TurnRunner.shutdown on redeploy raising CancelledError into produce()).
    await _wait(lambda: started.is_set())
    task = deps.turn_runner._tasks[_TRACE]
    task.cancel()

    await _wait(lambda: _TRACE in store.finished)
    finished = store.finished[_TRACE]
    assert finished["state"] == "cancelled"
    assert limiter.refund_calls == 1
    assert _REDIS_KEY not in idem.held


# ── 3. request-handshake guards (426 / 400) ────────────────────────────


class _PermissiveDeps:
    """Minimal deps — the guards under test fail before any of these are
    touched, so plain objects suffice."""

    def __init__(self) -> None:
        self.idempotency_store = _FakeIdempotency()
        self.rate_limiter = _RecordingRateLimiter()
        self.turn_store = _FakeTurnStore()
        self.turn_runner = TurnRunner(self.turn_store)


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(chat_api.router)
    app.dependency_overrides[get_current_user] = lambda: _USER
    app.dependency_overrides[get_deps] = _PermissiveDeps
    return TestClient(app, raise_server_exceptions=False)


def _chat_post(client: TestClient, headers: dict[str, str]):
    return client.post(
        "/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "lang": "en"},
        headers=headers,
    )


def test_missing_protocol_version_returns_426() -> None:
    client = _client()
    r = _chat_post(client, headers={})  # no X-Chat-Protocol-Version
    assert r.status_code == 426
    body = r.json()["detail"]
    assert body["code"] == "protocol_version_required"
    assert body["supported"] == ["1"]
    assert r.headers["X-Chat-Supported-Versions"] == "1"


def test_unsupported_protocol_version_returns_426() -> None:
    client = _client()
    r = _chat_post(client, headers={"X-Chat-Protocol-Version": "2"})
    assert r.status_code == 426
    assert r.json()["detail"]["received"] == "2"


def test_malformed_idempotency_key_returns_400() -> None:
    client = _client()
    r = _chat_post(
        client,
        headers={"X-Chat-Protocol-Version": "1", "Idempotency-Key": "bad key!"},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid Idempotency-Key"


def test_invalid_trace_id_on_get_turn_returns_400() -> None:
    client = _client()
    r = client.get("/chat/turn/not-a-valid-trace")
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid trace id"


def test_invalid_trace_id_on_cancel_turn_returns_400() -> None:
    client = _client()
    r = client.delete("/chat/turn/ZZZZ")
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid trace id"
