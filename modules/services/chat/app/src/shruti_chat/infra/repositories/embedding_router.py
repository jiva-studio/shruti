"""Per-dimension table router for pgvector embeddings.

Post-migration 0030 the schema splits embeddings into per-dim physical
tables: `chunk_embeddings_d{N}` and `attribution_emb_d{N}`. The active
dim for a deployment is configured via `EMBED_DIM` (`Settings.embed_dim`).
This router resolves the right table for that dim so callers (repository,
indexer, attribution lookup) don't have to know which table they're
hitting.

Adding a new dim is a two-step process:
  1. Write a new migration that creates `chunk_embeddings_d{N}` +
     `attribution_emb_d{N}` with their HNSW indices.
  2. Extend `_SUPPORTED_DIMS` here so the router accepts it.
"""

from __future__ import annotations

from typing import Final

# Dims with a dedicated per-dim table in migration 0030. Add a new entry
# only after a matching migration has shipped — `EmbeddingTableRouter`
# fails fast on an unsupported dim so a misconfigured deployment can't
# silently write into the wrong table.
_SUPPORTED_DIMS: Final[frozenset[int]] = frozenset({256, 768, 1024, 1536})


class EmbeddingTableRouter:
    """Resolves the per-dim table names + HNSW index names for a given dim."""

    __slots__ = (
        "dim",
        "chunk_table",
        "chunk_hnsw_index",
        "attribution_table",
        "attribution_hnsw_index",
    )

    def __init__(self, dim: int) -> None:
        if dim not in _SUPPORTED_DIMS:
            raise ValueError(
                f"EMBED_DIM={dim} is not supported. "
                f"Supported dims: {sorted(_SUPPORTED_DIMS)}. "
                f"Add a `chunk_embeddings_d{dim}` + `attribution_emb_d{dim}` "
                f"table in a new migration and extend _SUPPORTED_DIMS."
            )
        self.dim: int = dim
        self.chunk_table: str = f"chunk_embeddings_d{dim}"
        self.chunk_hnsw_index: str = f"{self.chunk_table}_hnsw"
        self.attribution_table: str = f"attribution_emb_d{dim}"
        self.attribution_hnsw_index: str = f"{self.attribution_table}_hnsw"

    def __repr__(self) -> str:
        return (
            f"EmbeddingTableRouter(dim={self.dim}, "
            f"chunk_table={self.chunk_table!r}, "
            f"attribution_table={self.attribution_table!r})"
        )
