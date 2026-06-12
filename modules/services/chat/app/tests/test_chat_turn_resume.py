"""GET/DELETE /chat/turn/{trace_id} — the resume + explicit-cancel surface.

A client that dropped the connection (backgrounded / app killed) polls the
turn by its client-minted trace id and either replays the buffered events
(`done`/`error`) or waits (`running`). Ownership is checked so one user
can't read or cancel another's turn, and a malformed id is rejected
before it reaches the store.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from lectorium_chat.api import chat as chat_api
from lectorium_chat.api._auth import get_current_user
from lectorium_chat.application.turn_runner import TurnRunner
from lectorium_chat.composition import get_deps
from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser


class _FakeTurnStore:
    """In-memory TurnStore mirroring the Redis adapter's contract."""

    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}
        self.cancelled: set[str] = set()

    async def mark_running(self, trace_id: str, user_id: str) -> None:
        self.records[trace_id] = {"state": "running", "user_id": user_id}

    async def heartbeat(self, trace_id: str) -> None:
        return None

    async def finish(
        self, trace_id: str, *, state: str, events: list[dict[str, Any]], user_id: str
    ) -> None:
        self.records[trace_id] = {"state": state, "user_id": user_id, "events": events}

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return self.records.get(trace_id)

    async def request_cancel(self, trace_id: str) -> None:
        self.cancelled.add(trace_id)

    async def is_cancelled(self, trace_id: str) -> bool:
        return trace_id in self.cancelled


class _Deps:
    def __init__(self, turn_store: _FakeTurnStore) -> None:
        self.turn_store = turn_store
        # Real runner over the fake store — DELETE routes cancel through it.
        self.turn_runner = TurnRunner(turn_store)


_USER = VerifiedUser(id="user-1", anonymous=False, tier="free")
_OTHER = VerifiedUser(id="user-2", anonymous=False, tier="free")
_TRACE = "a" * 32  # 32-hex, passes _TRACE_ID_RE


def _client(deps: _Deps, user: VerifiedUser = _USER) -> TestClient:
    app = FastAPI()
    app.include_router(chat_api.router)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_deps] = lambda: deps
    return TestClient(app, raise_server_exceptions=False)


def test_get_returns_finished_blob() -> None:
    store = _FakeTurnStore()
    events = [{"event": "delta", "data": "{\"text\": \"hi\"}"}]
    store.records[_TRACE] = {"state": "done", "user_id": _USER.id, "events": events}

    r = _client(_Deps(store)).get(f"/chat/turn/{_TRACE}")

    assert r.status_code == 200
    assert r.json() == {"state": "done", "events": events}


def test_get_running_has_no_events() -> None:
    store = _FakeTurnStore()
    store.records[_TRACE] = {"state": "running", "user_id": _USER.id}

    r = _client(_Deps(store)).get(f"/chat/turn/{_TRACE}")

    assert r.status_code == 200
    assert r.json() == {"state": "running", "events": []}


def test_get_404_when_absent() -> None:
    r = _client(_Deps(_FakeTurnStore())).get(f"/chat/turn/{_TRACE}")
    assert r.status_code == 404


def test_get_404_for_other_users_turn() -> None:
    store = _FakeTurnStore()
    store.records[_TRACE] = {"state": "done", "user_id": _OTHER.id, "events": []}

    # Owned by user-2; user-1 must not see it exist.
    r = _client(_Deps(store), user=_USER).get(f"/chat/turn/{_TRACE}")
    assert r.status_code == 404


def test_get_400_on_malformed_trace_id() -> None:
    r = _client(_Deps(_FakeTurnStore())).get("/chat/turn/not-a-trace")
    assert r.status_code == 400


def test_delete_requests_cancel() -> None:
    store = _FakeTurnStore()
    store.records[_TRACE] = {"state": "running", "user_id": _USER.id}

    r = _client(_Deps(store)).delete(f"/chat/turn/{_TRACE}")

    assert r.status_code == 200
    assert _TRACE in store.cancelled


def test_delete_404_for_other_users_turn() -> None:
    store = _FakeTurnStore()
    store.records[_TRACE] = {"state": "running", "user_id": _OTHER.id}

    r = _client(_Deps(store), user=_USER).delete(f"/chat/turn/{_TRACE}")

    assert r.status_code == 404
    # Must not have signalled cancel on someone else's turn.
    assert _TRACE not in store.cancelled
