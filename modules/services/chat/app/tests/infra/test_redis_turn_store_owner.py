"""The `turn:<id>:owner` marker, against fakeredis.

It is what `POST /chat/feedback` authorises against, so the two things
that matter are that `mark_running` writes it alongside the turn record
and that it outlives the record by a wide margin (#1570 follow-up: the
24h buffer TTL was making day-old feedback 404).
"""

from __future__ import annotations

import pytest

fakeredis = pytest.importorskip("fakeredis")

from shruti_chat.infra.turn_store.redis_turn_store import RedisTurnStore

_TRACE = "b" * 32


@pytest.fixture
def store() -> RedisTurnStore:
    s = RedisTurnStore.__new__(RedisTurnStore)
    s._running_ttl_s = 180
    s._result_ttl_s = 86_400
    s._cancel_ttl_s = 180
    s._owner_ttl_s = 7_776_000
    s._client = fakeredis.aioredis.FakeRedis(decode_responses=False)
    return s


async def test_mark_running_writes_the_owner_marker(store: RedisTurnStore) -> None:
    await store.mark_running(_TRACE, "user-1")

    assert await store.get_owner(_TRACE) == "user-1"
    assert (await store.get(_TRACE))["user_id"] == "user-1"


async def test_the_marker_outlives_the_turn_record(store: RedisTurnStore) -> None:
    await store.mark_running(_TRACE, "user-1")
    await store.finish(_TRACE, state="done", events=[], user_id="user-1")

    record_ttl = await store._client.ttl(f"turn:{_TRACE}")
    owner_ttl = await store._client.ttl(f"turn:{_TRACE}:owner")

    assert record_ttl <= 86_400
    assert owner_ttl > 86_400


async def test_finish_does_not_clobber_the_marker(store: RedisTurnStore) -> None:
    """`finish` overwrites the record in place; the marker is a separate
    key and must survive that."""
    await store.mark_running(_TRACE, "user-1")
    await store.finish(_TRACE, state="done", events=[{"e": 1}], user_id="user-1")

    assert await store.get_owner(_TRACE) == "user-1"


async def test_get_owner_is_none_for_an_unknown_trace(store: RedisTurnStore) -> None:
    assert await store.get_owner("c" * 32) is None
