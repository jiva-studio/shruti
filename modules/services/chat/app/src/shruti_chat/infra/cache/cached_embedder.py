"""CachedEmbedder — decorator over any `Embedder` that memoises
single-query embeddings.

`embed_query` is the hot path: every research turn hits it at least
once (for the user question) and again for every expansion / topic
batch via `embed_documents`. The same handful of canonical phrasings
("что такое душа", "what is bhakti") recur across users, so a network
roundtrip per call is wasteful.

`embed_documents` is intentionally NOT cached at this layer: it is
already batched (96 inputs per call) and the cache key would be the
entire batch, which has poor reuse. If we want per-text reuse inside
documents we'd shard the batch — out of scope for Stage 2.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.application.cache_helpers import TTL_30D, cached_embedding


class CachedEmbedder:
    def __init__(self, inner: Any, kv_cache: Any) -> None:
        self._inner = inner
        self._cache = kv_cache
        # Mirror the wrapped embedder's metadata so the rest of the
        # service can read `embedder.name` / `.dim` without knowing it
        # was wrapped.
        self.name = inner.name
        self.dim = inner.dim

    async def embed_query(self, text: str) -> list[float]:
        return await cached_embedding(
            self._cache,
            text=text,
            model=self.name,
            ttl_s=TTL_30D,
            factory=lambda: self._inner.embed_query(text),
        )

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        # Pass-through: see module docstring on why batch caching is a
        # poor fit at this layer.
        return await self._inner.embed_documents(texts)
