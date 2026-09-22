"""Domain helpers that wrap deterministic LLM / DB calls in KVCache."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Awaitable, Callable, TypeVar

from pydantic import BaseModel

from lectorium_chat.domain.ports.kv_cache import KVCache

T = TypeVar("T", bound=BaseModel)

_KEY_PREFIX = "lc:v1"

# TTL constants (seconds)
TTL_7D = 7 * 24 * 3600
TTL_14D = 14 * 24 * 3600
TTL_30D = 30 * 24 * 3600
TTL_24H = 24 * 3600
TTL_6H = 6 * 3600


def _serialize_for_key(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, (set, frozenset)):
        return sorted(value)
    if isinstance(value, dict):
        return {k: _serialize_for_key(v) for k, v in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_serialize_for_key(v) for v in value]
    return value


def make_key(ns: str, key_parts: Any, version: str | None = None) -> str:
    """Compose the canonical key `lc:v1:{ns}:{ver}:{hash}`."""
    if version is None:
        try:
            from lectorium_chat.domain.cache_versions import cache_version_for
            version = cache_version_for(ns)
        except Exception:
            version = "0"
    canon = json.dumps(_serialize_for_key(key_parts), ensure_ascii=False, sort_keys=True)
    digest = hashlib.blake2b(canon.encode("utf-8"), digest_size=12).hexdigest()
    return f"{_KEY_PREFIX}:{ns}:{version}:{digest}"


async def cached_llm_json(
    cache: KVCache,
    *,
    ns: str,
    key_parts: Any,
    ttl_s: int,
    schema: type[T],
    factory: Callable[[], Awaitable[T]],
) -> T:
    """Memoise an LLM call that returns a pydantic `schema` instance."""
    key = make_key(ns, key_parts)
    cached = await cache.get(key)
    if cached is not None:
        try:
            return schema.model_validate_json(cached)
        except Exception:  # noqa: BLE001
            pass
    value = await factory()
    try:
        payload = value.model_dump_json().encode("utf-8")
        await cache.set(key, payload, ttl_s=ttl_s)
    except Exception:  # noqa: BLE001
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
    """Memoise a call that returns any JSON-serialisable value."""
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
    """Memoise an embedding vector by `(text, model)`."""
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
