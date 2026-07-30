"""Tests for the ingest.request broker publisher.

Redis Streams path is exercised against fakeredis; the no-op path (no broker
configured) must log + report False without raising.
"""

from __future__ import annotations

import pytest

from lectorium_chat.agent.tools.add_to_library import add_to_library_publish
from lectorium_chat.infra.broker.publisher import (
    NoopIngestPublisher,
    RedisStreamsIngestPublisher,
    build_ingest_publisher,
)

fakeredis = pytest.importorskip("fakeredis")


@pytest.fixture
def publisher():
    fake = fakeredis.aioredis.FakeRedis(decode_responses=False)
    p = RedisStreamsIngestPublisher.__new__(RedisStreamsIngestPublisher)
    p._client = fake
    p._stream = "ingest.request"
    return p


async def test_redis_publish_xadds_payload(publisher) -> None:
    import json

    ok = await publisher.publish(
        user_id="u1", url="https://y/1", jwt="tok", title="Lecture 1", author="Some Swami"
    )
    assert ok is True
    entries = await publisher._client.xrange("ingest.request")
    assert len(entries) == 1
    _id, fields = entries[0]
    # Single `payload` envelope decoded by the orchestrator's Request struct.
    assert set(fields) == {b"payload"}
    body = json.loads(fields[b"payload"])
    assert body == {
        "request_id": "",
        "url": "https://y/1",
        "token": "tok",
        "user_id": "u1",
        "title": "Lecture 1",
        "author": "Some Swami",
    }


async def test_publish_carries_the_correlation_id(publisher) -> None:
    """`request_id` is what joins a library ingest to the chat turn that asked
    for it, across chat -> orchestrator -> ingest worker -> storage-sync. If it
    is dropped here the whole chain loses its only shared key."""
    import json

    await publisher.publish(
        user_id="u1", url="https://y/1", jwt="tok", request_id="trace-abc"
    )
    _id, fields = (await publisher._client.xrange("ingest.request"))[0]
    assert json.loads(fields[b"payload"])["request_id"] == "trace-abc"


async def test_publish_falls_back_to_the_ambient_turn_trace(publisher) -> None:
    """The card-tap path reaches the publisher without threading the id down,
    so it is recovered from the turn's structlog context instead."""
    import json

    import structlog

    structlog.contextvars.bind_contextvars(trace_id="ambient-xyz")
    try:
        await publisher.publish(user_id="u1", url="https://y/1", jwt="tok")
    finally:
        structlog.contextvars.unbind_contextvars("trace_id")

    _id, fields = (await publisher._client.xrange("ingest.request"))[0]
    assert json.loads(fields[b"payload"])["request_id"] == "ambient-xyz"


async def test_redis_publish_soft_fails_on_error() -> None:
    class _Boom:
        async def xadd(self, *a, **k):
            from redis.exceptions import RedisError
            raise RedisError("down")

    p = RedisStreamsIngestPublisher.__new__(RedisStreamsIngestPublisher)
    p._client = _Boom()
    p._stream = "ingest.request"
    # Never raises — a down broker must not fail the chat turn.
    assert await p.publish(user_id="u1", url="u", jwt="t") is False


async def test_noop_publisher_reports_false() -> None:
    assert await NoopIngestPublisher().publish(user_id="u1", url="u", jwt="t") is False


def test_build_ingest_publisher_selects_noop_when_unconfigured() -> None:
    assert isinstance(build_ingest_publisher(None), NoopIngestPublisher)


async def test_action_tool_publishes_and_emits_event(publisher) -> None:
    events: list = []

    def _yield(t, d):
        events.append((t, d))

    result = await add_to_library_publish(
        url="https://y/1",
        user_id="u1",
        jwt="tok",
        title="T",
        publisher=publisher,
        yield_event=_yield,
    )
    assert result["ok"] is True and result["published"] is True
    assert result["action_id"]
    # SSE action emitted with the added_to_library card payload.
    assert events and events[0][0] == "action"
    assert events[0][1]["kind"] == "added_to_library"
    assert events[0][1]["payload"]["url"] == "https://y/1"
    assert events[0][1]["payload"]["queued"] is True


async def test_action_tool_rejects_missing_url() -> None:
    assert (await add_to_library_publish(url="", user_id="u", jwt="t"))["error"] == "url_required"


async def test_action_tool_rejects_missing_identity() -> None:
    r = await add_to_library_publish(url="https://y/1", user_id="", jwt="")
    assert r["error"] == "identity_required"
