"""MemoCache — port for memoising deterministic LLM and DB calls.

Keys are versioned per namespace, so a catalog or library swap (or an
embedding model change) makes the old entries unreachable without a flush.
Every `cached_*` call degrades to its factory: an unreadable entry or a
failing write costs one recomputation, never the caller's request.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Protocol, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class MemoCache(Protocol):
    def make_key(self, ns: str, key_parts: Any) -> str:
        """The versioned key `key_parts` is stored under in namespace `ns`."""
        ...

    async def get(self, key: str) -> bytes | None: ...

    async def set(self, key: str, value: bytes, *, ttl_s: int) -> None: ...

    async def cached_llm_json(
        self,
        *,
        ns: str,
        key_parts: Any,
        ttl_s: int,
        schema: type[T],
        factory: Callable[[], Awaitable[T]],
    ) -> T:
        """Memoise a call that returns a pydantic `schema` instance."""
        ...

    async def cached_str(
        self,
        *,
        ns: str,
        key_parts: Any,
        ttl_s: int,
        factory: Callable[[], Awaitable[str]],
    ) -> str:
        """Memoise a call that returns a plain string."""
        ...

    async def cached_json(
        self,
        *,
        ns: str,
        key_parts: Any,
        ttl_s: int,
        factory: Callable[[], Awaitable[Any]],
        max_bytes: int = 16 * 1024,
    ) -> Any:
        """Memoise a call that returns any JSON-serialisable value."""
        ...

    async def cached_embedding(
        self,
        *,
        text: str,
        model: str,
        ttl_s: int,
        factory: Callable[[], Awaitable[list[float]]],
    ) -> list[float]:
        """Memoise an embedding vector by `(text, model)`."""
        ...
