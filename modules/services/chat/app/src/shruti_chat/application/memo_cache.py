"""`MemoCache` over a `KVCache`, keyed on the process's cache version tags."""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, TypeVar

from pydantic import BaseModel

from shruti_chat.domain.cache import make_key
from shruti_chat.domain.ports.cache_versions import CacheVersions
from shruti_chat.domain.ports.kv_cache import KVCache

T = TypeVar("T", bound=BaseModel)


class KVMemoCache:
    """Every read that cannot be decoded and every write that fails falls
    through to the factory: a cache is an optimisation, never a reason for a
    request to fail."""

    def __init__(self, kv: KVCache, versions: CacheVersions) -> None:
        self._kv = kv
        self._versions = versions

    def make_key(self, ns: str, key_parts: Any) -> str:
        return make_key(ns, key_parts, self._versions.version_for(ns))

    async def get(self, key: str) -> bytes | None:
        return await self._kv.get(key)

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
        await self._kv.set(key, value, ttl_s=ttl_s)

    async def cached_llm_json(
        self,
        *,
        ns: str,
        key_parts: Any,
        ttl_s: int,
        schema: type[T],
        factory: Callable[[], Awaitable[T]],
    ) -> T:
        key = self.make_key(ns, key_parts)
        cached = await self._kv.get(key)
        if cached is not None:
            try:
                return schema.model_validate_json(cached)
            except Exception:  # noqa: BLE001 — an entry of another shape is recomputed
                pass
        value = await factory()
        try:
            payload = value.model_dump_json().encode("utf-8")
            await self._kv.set(key, payload, ttl_s=ttl_s)
        except Exception:  # noqa: BLE001 — a lost write costs one recomputation later
            pass
        return value

    async def cached_str(
        self,
        *,
        ns: str,
        key_parts: Any,
        ttl_s: int,
        factory: Callable[[], Awaitable[str]],
    ) -> str:
        key = self.make_key(ns, key_parts)
        cached = await self._kv.get(key)
        if cached is not None:
            try:
                return cached.decode("utf-8")
            except UnicodeDecodeError:
                pass
        value = await factory()
        try:
            await self._kv.set(key, value.encode("utf-8"), ttl_s=ttl_s)
        except Exception:  # noqa: BLE001 — a lost write costs one recomputation later
            pass
        return value

    async def cached_json(
        self,
        *,
        ns: str,
        key_parts: Any,
        ttl_s: int,
        factory: Callable[[], Awaitable[Any]],
        max_bytes: int = 16 * 1024,
    ) -> Any:
        key = self.make_key(ns, key_parts)
        cached = await self._kv.get(key)
        if cached is not None:
            try:
                return json.loads(cached)
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
        value = await factory()
        try:
            payload = json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")
            if len(payload) <= max_bytes:
                await self._kv.set(key, payload, ttl_s=ttl_s)
        except Exception:  # noqa: BLE001 — a lost write costs one recomputation later
            pass
        return value

    async def cached_embedding(
        self,
        *,
        text: str,
        model: str,
        ttl_s: int,
        factory: Callable[[], Awaitable[list[float]]],
    ) -> list[float]:
        key = self.make_key("embed_query", {"text": text, "model": model})
        cached = await self._kv.get(key)
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
            await self._kv.set(key, payload, ttl_s=ttl_s)
        except Exception:  # noqa: BLE001 — a lost write costs one recomputation later
            pass
        return vec
