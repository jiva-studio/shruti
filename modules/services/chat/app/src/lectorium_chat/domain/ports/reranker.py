"""RerankerPort — cross-encoder (query, document) relevance scoring.

A Protocol mirroring `ports/embedder.py`. The concrete adapter lives in
`infra/rerank.py` (`VoyageReranker`); other backends (self-hosted BGE via
TEI, etc.) can satisfy the same shape later behind the provider switch.

`rerank` scores each document against the query JOINTLY (unlike the
bi-encoder cosine path) and returns `(orig_index, score)` pairs sorted by
descending relevance — `orig_index` indexes back into the submitted
`documents` list, never the survivors.
"""

from __future__ import annotations

from typing import Protocol


class RerankerPort(Protocol):
    name: str

    async def rerank(
        self,
        query: str,
        documents: list[str],
        *,
        top_k: int | None = None,
    ) -> list[tuple[int, float]]:
        ...
