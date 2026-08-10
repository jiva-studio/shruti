"""`RedisTurnStore` against fakeredis.

Three properties carry the resume feature: the running marker lives on a
short heartbeat-refreshed TTL (a lapsed one is how a client learns the turn
was orphaned), the finished blob overwrites it once under the 24h TTL, and
every op degrades softly — buffering must never be able to fail a live turn.
"""

from __future__ import annotations

import json

import pytest

fakeredis = pytest.importorskip("fakeredis")

from redis.exceptions import RedisError

from shruti_chat.infra.turn_store import redis_turn_store as mod
from shruti_chat.infra.turn_store.redis_turn_store import (
    RedisTurnStore,
)

TRACE = "abc123"


@pytest.fixture
def store(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis(decode_responses=False)
    monkeypatch.setattr(mod.redis_async, "from_url", lambda *a, **kw: fake)
    return RedisTurnStore("redis://fake")


async def test_mark_running_stores_a_marker_with_the_liveness_ttl(store) -> None:
    await store.mark_running(TRACE, "u1")
    assert await store.get(TRACE) == {"state": "running", "user_id": "u1"}
    assert await store._client.ttl(f"turn:{TRACE}") == 180


async def test_heartbeat_refreshes_the_running_window(store) -> None:
    await store.mark_running(TRACE, "u1")
    await store._client.expire(f"turn:{TRACE}", 5)
    await store.heartbeat(TRACE)
    assert await store._client.ttl(f"turn:{TRACE}") == 180


async def test_heartbeat_on_a_missing_turn_is_a_noop(store) -> None:
    await store.heartbeat("gone")
    assert await store.get("gone") is None


async def test_finish_overwrites_the_marker_with_the_events(store) -> None:
    await store.mark_running(TRACE, "u1")
    events = [{"type": "delta", "data": {"text": "hi"}}]
    await store.finish(TRACE, state="done", events=events, user_id="u1")
    assert await store.get(TRACE) == {
        "state": "done",
        "user_id": "u1",
        "events": events,
    }


async def test_finished_turn_is_kept_for_24h(store) -> None:
    await store.mark_running(TRACE, "u1")
    await store.finish(TRACE, state="done", events=[], user_id="u1")
    assert await store._client.ttl(f"turn:{TRACE}") == 86_400


async def test_finish_preserves_non_ascii_text(store) -> None:
    """`ensure_ascii=False` — a resumed Russian answer must come back as it
    went in, not as \\uXXXX escapes."""
    events = [{"type": "delta", "data": {"text": "Харе Кришна"}}]
    await store.finish(TRACE, state="done", events=events, user_id="u1")
    blob = await store.get(TRACE)
    assert blob["events"][0]["data"]["text"] == "Харе Кришна"


async def test_get_returns_none_for_an_unknown_turn(store) -> None:
    assert await store.get("never-seen") is None


async def test_get_returns_none_on_a_corrupt_blob(store) -> None:
    """A half-written value must read as "no buffer", not blow up the poll."""
    await store._client.set(f"turn:{TRACE}", b"{not json")
    assert await store.get(TRACE) is None


async def test_get_returns_none_on_redis_error(store) -> None:
    async def _boom(*a, **kw):
        raise RedisError("down")

    store._client.get = _boom
    assert await store.get(TRACE) is None


async def test_cancel_flag_is_a_separate_key_with_its_own_ttl(store) -> None:
    await store.mark_running(TRACE, "u1")
    await store.request_cancel(TRACE)
    assert await store.is_cancelled(TRACE) is True
    assert await store._client.ttl(f"turn:{TRACE}:cancel") == 180
    assert await store.get(TRACE) == {"state": "running", "user_id": "u1"}


async def test_is_cancelled_is_false_when_no_flag_was_set(store) -> None:
    assert await store.is_cancelled(TRACE) is False


async def test_is_cancelled_degrades_to_false_on_redis_error(store) -> None:
    """Degrade closed: an infra hiccup must never kill a live turn."""

    async def _boom(*a, **kw):
        raise TimeoutError("op timeout")

    store._client.exists = _boom
    assert await store.is_cancelled(TRACE) is False


@pytest.mark.parametrize("failing_op", ["set", "expire"])
async def test_writes_swallow_redis_errors(store, failing_op: str) -> None:
    async def _boom(*a, **kw):
        raise RedisError("down")

    setattr(store._client, failing_op, _boom)
    await store.mark_running(TRACE, "u1")
    await store.heartbeat(TRACE)
    await store.finish(TRACE, state="done", events=[], user_id="u1")
    await store.request_cancel(TRACE)


async def test_ttls_are_configurable(monkeypatch) -> None:
    fake = fakeredis.aioredis.FakeRedis(decode_responses=False)
    monkeypatch.setattr(mod.redis_async, "from_url", lambda *a, **kw: fake)
    store = RedisTurnStore(
        "redis://fake", running_ttl_s=7, result_ttl_s=11, cancel_ttl_s=13
    )
    await store.mark_running(TRACE, "u1")
    assert await fake.ttl(f"turn:{TRACE}") == 7
    await store.request_cancel(TRACE)
    assert await fake.ttl(f"turn:{TRACE}:cancel") == 13
    await store.finish(TRACE, state="error", events=[], user_id="u1")
    assert await fake.ttl(f"turn:{TRACE}") == 11


async def test_stored_blob_is_json_bytes(store) -> None:
    """The on-wire shape other replicas read — a dict, not a pickle."""
    await store.finish(TRACE, state="done", events=[{"type": "end"}], user_id="u1")
    raw = await store._client.get(f"turn:{TRACE}")
    assert json.loads(raw)["state"] == "done"


async def test_close_swallows_errors(store) -> None:
    async def _boom(*a, **kw):
        raise RedisError("already closed")

    store._client.aclose = _boom
    await store.close()


async def test_noop_store_is_silent_and_never_resumes() -> None:
    """The keyless-deploy fallback. Resume is off, but every port method must
    still answer — the turn path calls them unconditionally."""
    from shruti_chat.infra.turn_store.noop import NoopTurnStore

    s = NoopTurnStore()
    await s.mark_running(TRACE, "u1")
    await s.heartbeat(TRACE)
    await s.finish(TRACE, state="done", events=[{"type": "end"}], user_id="u1")
    await s.request_cancel(TRACE)
    assert await s.get(TRACE) is None
    assert await s.is_cancelled(TRACE) is False
