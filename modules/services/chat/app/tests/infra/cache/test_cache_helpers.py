"""cached_llm_json / cached_str / cached_json: end-to-end with MemoryKVCache."""

from __future__ import annotations

from pydantic import BaseModel

from lectorium_chat.application.cache_helpers import (
    cached_json,
    cached_llm_json,
    cached_str,
    make_key,
)
from lectorium_chat.infra.cache.memory_kv_cache import MemoryKVCache


class _Schema(BaseModel):
    value: int
    label: str


async def test_cached_llm_json_roundtrip():
    cache = MemoryKVCache(max_entries=8)
    calls = 0

    async def factory() -> _Schema:
        nonlocal calls
        calls += 1
        return _Schema(value=42, label="hello")

    a = await cached_llm_json(
        cache, ns="router", key_parts={"q": "hi"}, ttl_s=60,
        schema=_Schema, factory=factory,
    )
    b = await cached_llm_json(
        cache, ns="router", key_parts={"q": "hi"}, ttl_s=60,
        schema=_Schema, factory=factory,
    )
    assert a == b == _Schema(value=42, label="hello")
    assert calls == 1


async def test_cached_str_roundtrip():
    cache = MemoryKVCache(max_entries=8)
    calls = 0

    async def factory() -> str:
        nonlocal calls
        calls += 1
        return "Новый чат"

    a = await cached_str(cache, ns="title", key_parts={"q": "x"}, ttl_s=60, factory=factory)
    b = await cached_str(cache, ns="title", key_parts={"q": "x"}, ttl_s=60, factory=factory)
    assert a == b == "Новый чат"
    assert calls == 1


async def test_cached_json_skips_oversize_payload():
    cache = MemoryKVCache(max_entries=8)
    huge = ["x" * 1000 for _ in range(100)]  # ~100 KB JSON

    async def factory():
        return huge

    a = await cached_json(
        cache, ns="pg_chunk_search", key_parts={"x": 1}, ttl_s=60,
        factory=factory, max_bytes=10 * 1024,
    )
    assert a == huge
    # Second call goes through the factory again because the first
    # payload exceeded the size cap.
    a2 = await cached_json(
        cache, ns="pg_chunk_search", key_parts={"x": 1}, ttl_s=60,
        factory=factory, max_bytes=10 * 1024,
    )
    assert a2 == huge


def test_make_key_is_stable_for_dict_order():
    k1 = make_key("router", {"a": 1, "b": 2})
    k2 = make_key("router", {"b": 2, "a": 1})
    assert k1 == k2


def test_make_key_changes_on_input_change():
    a = make_key("router", {"q": "one"})
    b = make_key("router", {"q": "two"})
    assert a != b
