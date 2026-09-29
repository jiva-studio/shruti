"""The cache helpers in `domain.cache` degrade to the factory, never to an error.

A corrupt entry (another schema, bytes that are not UTF-8 or not JSON) or a
failing cache write must cost one recomputation, not the turn.
"""

from __future__ import annotations

import json

from pydantic import BaseModel

from shruti_chat.domain.cache import (
    cached_embedding,
    cached_json,
    cached_llm_json,
    cached_str,
    make_key,
)
from shruti_chat.infra.cache.memory_kv_cache import MemoryKVCache


class _Schema(BaseModel):
    value: int


class _BrokenWrites(MemoryKVCache):
    """Reads work, every write raises — an L2 outage mid-turn."""

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
        raise ConnectionError("cache down")


class _Counter:
    def __init__(self, value):
        self.value = value
        self.calls = 0

    async def __call__(self):
        self.calls += 1
        return self.value


async def test_llm_json_recomputes_on_an_entry_of_another_shape() -> None:
    cache = MemoryKVCache(max_entries=8)
    key = make_key("router", {"q": "x"})
    await cache.set(key, b'{"unexpected": true}', ttl_s=60)
    factory = _Counter(_Schema(value=7))

    got = await cached_llm_json(
        cache, ns="router", key_parts={"q": "x"}, ttl_s=60,
        schema=_Schema, factory=factory,
    )
    assert got == _Schema(value=7)
    assert factory.calls == 1
    assert await cache.get(key) == b'{"value":7}'


async def test_llm_json_survives_a_failing_write() -> None:
    factory = _Counter(_Schema(value=1))
    got = await cached_llm_json(
        _BrokenWrites(max_entries=8), ns="router", key_parts={"q": "x"},
        ttl_s=60, schema=_Schema, factory=factory,
    )
    assert got == _Schema(value=1)


async def test_str_recomputes_on_bytes_that_are_not_utf8() -> None:
    cache = MemoryKVCache(max_entries=8)
    await cache.set(make_key("title", {"q": "x"}), b"\xff\xfe", ttl_s=60)
    factory = _Counter("Title")

    got = await cached_str(cache, ns="title", key_parts={"q": "x"}, ttl_s=60, factory=factory)
    assert got == "Title"
    assert factory.calls == 1


async def test_str_survives_a_failing_write() -> None:
    got = await cached_str(
        _BrokenWrites(max_entries=8), ns="title", key_parts={"q": "x"},
        ttl_s=60, factory=_Counter("Title"),
    )
    assert got == "Title"


async def test_json_roundtrip_and_recompute_on_garbage() -> None:
    cache = MemoryKVCache(max_entries=8)
    factory = _Counter({"langs": ["ru", "en"]})
    first = await cached_json(cache, ns="corpus_langs", key_parts=1, ttl_s=60, factory=factory)
    second = await cached_json(cache, ns="corpus_langs", key_parts=1, ttl_s=60, factory=factory)
    assert first == second == {"langs": ["ru", "en"]}
    assert factory.calls == 1

    await cache.set(make_key("corpus_langs", 2), b"not json", ttl_s=60)
    await cached_json(cache, ns="corpus_langs", key_parts=2, ttl_s=60, factory=factory)
    assert factory.calls == 2


async def test_json_survives_a_failing_write() -> None:
    got = await cached_json(
        _BrokenWrites(max_entries=8), ns="corpus_langs", key_parts=1,
        ttl_s=60, factory=_Counter([1, 2]),
    )
    assert got == [1, 2]


async def test_embedding_roundtrip() -> None:
    cache = MemoryKVCache(max_entries=8)
    factory = _Counter([0.1, 0.2])
    a = await cached_embedding(cache, text="t", model="m", ttl_s=60, factory=factory)
    b = await cached_embedding(cache, text="t", model="m", ttl_s=60, factory=factory)
    assert a == b == [0.1, 0.2]
    assert factory.calls == 1


async def test_embedding_recomputes_on_a_non_list_or_garbage_entry() -> None:
    cache = MemoryKVCache(max_entries=8)
    factory = _Counter([0.5])
    key = make_key("embed_query", {"text": "t", "model": "m"})

    await cache.set(key, json.dumps({"not": "a vector"}).encode(), ttl_s=60)
    assert await cached_embedding(cache, text="t", model="m", ttl_s=60, factory=factory) == [0.5]
    await cache.set(key, b"\x00garbage", ttl_s=60)
    assert await cached_embedding(cache, text="t", model="m", ttl_s=60, factory=factory) == [0.5]
    assert factory.calls == 2


async def test_embedding_survives_a_failing_write() -> None:
    got = await cached_embedding(
        _BrokenWrites(max_entries=8), text="t", model="m", ttl_s=60,
        factory=_Counter([0.3]),
    )
    assert got == [0.3]


def test_make_key_canonicalises_models_sets_and_sequences() -> None:
    assert make_key("router", {"s": {"b", "a"}}) == make_key("router", {"s": ["a", "b"]})
    assert make_key("router", (1, 2)) == make_key("router", [1, 2])
    assert make_key("router", _Schema(value=3)) == make_key("router", {"value": 3})


def test_make_key_uses_the_explicit_version() -> None:
    assert make_key("router", "q", version="v9").startswith("lc:v1:router:v9:")
