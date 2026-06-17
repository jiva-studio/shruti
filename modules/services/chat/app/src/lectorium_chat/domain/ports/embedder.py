"""EmbedderPort — text → vector embedding.

A Protocol over the existing `indexer.embed.Embedder` ABC.
`OpenAICompatEmbedder` already satisfies the shape structurally, so
the implementation stays where it is for now — Phase 7 may move it
under `infra/embedder/` for full hex symmetry.

`name` and `dim` are model identity bits that callers occasionally
need (e.g. for the `embed_model` SQL filter in PgChunkRepository).
"""

from __future__ import annotations

from typing import Protocol


class EmbedderPort(Protocol):
    name: str
    dim: int

    async def embed_query(self, text: str) -> list[float]:
        ...

    async def embed_queries(self, texts: list[str]) -> list[list[float]]:
        ...

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        ...
