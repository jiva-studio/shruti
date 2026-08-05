"""Thin helpers that wrap deterministic LLM / DB calls in the KVCache.

Keeping the cache logic out of business code: the wrapper computes the
key (namespace + version segment + canonical input hash), serialises
the result to bytes, and falls through to the factory on any backend
issue. Call sites read like one-liners.

Conventions:
- `ns` is a stable short string (see `application.cache_versions.NAMESPACE_DEPS`)
- `key_parts` is anything that uniquely identifies the call inside `ns`;
  it's canonicalised (JSON, sort_keys) and blake2b-hashed to 12 bytes
- pydantic models in `key_parts` are serialised via `.model_dump_json()`
  so equivalent shapes hash the same regardless of attribute order
"""

from __future__ import annotations

import hashlib
import json
import sys
from typing import Any, Awaitable, Callable, TypeVar

from pydantic import BaseModel

from shruti_chat.domain.ports.kv_cache import KVCache
from shruti_chat.application import cache_versions


T = TypeVar("T", bound=BaseModel)


_KEY_PREFIX = "lc:v1"


def _serialize_for_key(value: Any) -> Any:
    """Make `value` JSON-canonicalisable. pydantic → dict, set → sorted list,
    everything else: pass through (json.dumps will error on weird types,
    which is the right outcome — callers should put only hashable inputs)."""
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    if isinstance(value, dict):
        return {k: _serialize_for_key(v) for k, v in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_serialize_for_key(v) for v in value]
    return value


def make_key(ns: str, key_parts: Any) -> str:
    """Compose the canonical key `lc:v1:{ns}:{ver}:{hash}`."""
    canon = json.dumps(_serialize_for_key(key_parts), ensure_ascii=False, sort_keys=True)
    digest = hashlib.blake2b(canon.encode("utf-8"), digest_size=12).hexdigest()
    return f"{_KEY_PREFIX}:{ns}:{cache_versions.cache_version_for(ns)}:{digest}"


async def cached_llm_json(
    cache: KVCache,
    *,
    ns: str,
    key_parts: Any,
    ttl_s: int,
    schema: type[T],
    factory: Callable[[], Awaitable[T]],
) -> T:
    """Memoise an LLM call that returns a pydantic `schema` instance.

    Hit path: deserialise cached JSON into `schema`.
    Miss path: call `factory`, serialise via `.model_dump_json()`, cache,
    return.

    If the schema changes between deploys the cached payload may fail to
    deserialise; we catch and treat it as a miss so the next deploy
    transparently warms the cache with the new shape.
    """
    key = make_key(ns, key_parts)
    cached = await cache.get(key)
    if cached is not None:
        try:
            return schema.model_validate_json(cached)
        except Exception:  # noqa: BLE001 — schema rotation
            pass
    value = await factory()
    try:
        payload = value.model_dump_json().encode("utf-8")
        await cache.set(key, payload, ttl_s=ttl_s)
    except Exception:  # noqa: BLE001 — caching is best-effort
        pass
    return value


async def cached_str(
    cache: KVCache,
    *,
    ns: str,
    key_parts: Any,
    ttl_s: int,
    factory: Callable[[], Awaitable[str]],
) -> str:
    """Memoise an LLM call that returns a plain string (e.g. title)."""
    key = make_key(ns, key_parts)
    cached = await cache.get(key)
    if cached is not None:
        try:
            return cached.decode("utf-8")
        except UnicodeDecodeError:
            pass
    value = await factory()
    try:
        await cache.set(key, value.encode("utf-8"), ttl_s=ttl_s)
    except Exception:  # noqa: BLE001
        pass
    return value


async def cached_json(
    cache: KVCache,
    *,
    ns: str,
    key_parts: Any,
    ttl_s: int,
    factory: Callable[[], Awaitable[Any]],
    max_bytes: int = 16 * 1024,
) -> Any:
    """Memoise a call that returns any JSON-serialisable value.

    Use for DB query results (lists of dicts) and miscellaneous structured
    payloads. Skip caching when the serialised payload exceeds
    `max_bytes` — keeps Redis usage bounded.
    """
    key = make_key(ns, key_parts)
    cached = await cache.get(key)
    if cached is not None:
        try:
            return json.loads(cached)
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
    value = await factory()
    try:
        payload = json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")
        if len(payload) <= max_bytes:
            await cache.set(key, payload, ttl_s=ttl_s)
    except Exception:  # noqa: BLE001
        pass
    return value


async def cached_embedding(
    cache: KVCache,
    *,
    text: str,
    model: str,
    ttl_s: int,
    factory: Callable[[], Awaitable[list[float]]],
) -> list[float]:
    """Memoise an embedding vector by `(text, model)`. The payload is
    compact JSON of the float list; for 1536-dim models this is ~25 KB
    uncompressed — small enough to skip a size guard but worth a TTL."""
    key = make_key("embed_query", {"text": text, "model": model})
    cached = await cache.get(key)
    if cached is not None:
        try:
            vec = json.loads(cached)
            if isinstance(vec, list):
                return vec
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
    vec = await factory()
    try:
        payload = json.dumps(vec).encode("utf-8")
        await cache.set(key, payload, ttl_s=ttl_s)
    except Exception:  # noqa: BLE001
        pass
    return vec


# TTL constants (seconds) — central so the namespace table and the wrappers stay aligned.
TTL_7D = 7 * 24 * 3600
TTL_14D = 14 * 24 * 3600
TTL_30D = 30 * 24 * 3600
TTL_24H = 24 * 3600
TTL_6H = 6 * 3600
