"""KVMemoCache: end-to-end with MemoryKVCache, and the key format it writes."""

from __future__ import annotations

import hashlib

from pydantic import BaseModel

from shruti_chat.application.cache_versions import CacheVersionRegistry
from shruti_chat.application.memo_cache import KVMemoCache
from shruti_chat.domain.cache import make_key
from shruti_chat.infra.cache.memory_kv_cache import MemoryKVCache


class _Schema(BaseModel):
    value: int
    label: str


def _memo(versions: CacheVersionRegistry | None = None) -> KVMemoCache:
    return KVMemoCache(MemoryKVCache(max_entries=8), versions or CacheVersionRegistry())


async def test_cached_llm_json_roundtrip():
    memo = _memo()
    calls = 0

    async def factory() -> _Schema:
        nonlocal calls
        calls += 1
        return _Schema(value=42, label="hello")

    a = await memo.cached_llm_json(
        ns="router", key_parts={"q": "hi"}, ttl_s=60,
        schema=_Schema, factory=factory,
    )
    b = await memo.cached_llm_json(
        ns="router", key_parts={"q": "hi"}, ttl_s=60,
        schema=_Schema, factory=factory,
    )
    assert a == b == _Schema(value=42, label="hello")
    assert calls == 1


async def test_cached_str_roundtrip():
    memo = _memo()
    calls = 0

    async def factory() -> str:
        nonlocal calls
        calls += 1
        return "Новый чат"

    a = await memo.cached_str(ns="title", key_parts={"q": "x"}, ttl_s=60, factory=factory)
    b = await memo.cached_str(ns="title", key_parts={"q": "x"}, ttl_s=60, factory=factory)
    assert a == b == "Новый чат"
    assert calls == 1


async def test_cached_json_skips_oversize_payload():
    memo = _memo()
    huge = ["x" * 1000 for _ in range(100)]  # ~100 KB JSON
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        return huge

    a = await memo.cached_json(
        ns="pg_chunk_search", key_parts={"x": 1}, ttl_s=60,
        factory=factory, max_bytes=10 * 1024,
    )
    a2 = await memo.cached_json(
        ns="pg_chunk_search", key_parts={"x": 1}, ttl_s=60,
        factory=factory, max_bytes=10 * 1024,
    )
    assert a == a2 == huge
    assert calls == 2


async def test_a_tag_change_makes_old_entries_unreachable():
    versions = CacheVersionRegistry()
    memo = _memo(versions)
    calls = 0

    async def factory() -> str:
        nonlocal calls
        calls += 1
        return "meta"

    await memo.cached_str(ns="track_meta", key_parts=1, ttl_s=60, factory=factory)
    versions.set_tag("catalog", "20260920")
    await memo.cached_str(ns="track_meta", key_parts=1, ttl_s=60, factory=factory)
    await memo.cached_str(ns="track_meta", key_parts=1, ttl_s=60, factory=factory)
    assert calls == 2


def test_memo_keys_carry_the_namespace_version():
    versions = CacheVersionRegistry(embed_model_tag="e1")
    versions.set_tag("library", "20260918")
    memo = _memo(versions)
    key = memo.make_key("pg_chunk_search", {"q": 1})
    assert key == make_key("pg_chunk_search", {"q": 1}, "e1-20260918")
    assert key.startswith("lc:v1:pg_chunk_search:e1-20260918:")


def test_make_key_is_stable_for_dict_order():
    k1 = make_key("router", {"a": 1, "b": 2}, "0")
    k2 = make_key("router", {"b": 2, "a": 1}, "0")
    assert k1 == k2


def test_make_key_changes_on_input_change():
    a = make_key("router", {"q": "one"}, "0")
    b = make_key("router", {"q": "two"}, "0")
    assert a != b


def test_make_key_format_is_unchanged():
    # The digest is part of the Redis key format: entries written by a
    # running replica must stay readable by the next one.
    digest = hashlib.blake2b(b'{"q": "x"}', digest_size=12).hexdigest()
    assert make_key("router", {"q": "x"}, "0") == f"lc:v1:router:0:{digest}"
