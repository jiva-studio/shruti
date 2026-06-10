"""Unit tests for EmbeddingTableRouter.

Migration 0030 split embeddings into per-dim physical tables. The
router is the single resolver from `EMBED_DIM` → table name; every
write/read path (indexer, repository, attribution lookup) goes through
it. These tests pin the naming convention and the fail-fast contract
on an unknown dim.
"""

from __future__ import annotations

import pytest

from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter


@pytest.mark.parametrize(
    "dim,chunk_table,attribution_table",
    [
        (256, "chunk_embeddings_d256", "attribution_emb_d256"),
        (768, "chunk_embeddings_d768", "attribution_emb_d768"),
        (1024, "chunk_embeddings_d1024", "attribution_emb_d1024"),
        (1536, "chunk_embeddings_d1536", "attribution_emb_d1536"),
    ],
)
def test_router_resolves_supported_dims(
    dim: int, chunk_table: str, attribution_table: str
) -> None:
    router = EmbeddingTableRouter(dim=dim)
    assert router.dim == dim
    assert router.chunk_table == chunk_table
    assert router.attribution_table == attribution_table
    # chunk embeddings use per-kind PARTIAL HNSW indexes (migration 0035),
    # not a single named full index — the router no longer exposes one.
    assert not hasattr(router, "chunk_hnsw_index")
    assert router.attribution_hnsw_index == f"{attribution_table}_hnsw"


@pytest.mark.parametrize("dim", [0, 1, 100, 384, 512, 2048, 3072, -1])
def test_router_rejects_unsupported_dim(dim: int) -> None:
    """Unsupported dim must raise — silently routing into a missing
    physical table would write 0 rows and surface only as a stale
    ANN search returning [], which is a debugging nightmare."""
    with pytest.raises(ValueError) as excinfo:
        EmbeddingTableRouter(dim=dim)
    msg = str(excinfo.value)
    assert str(dim) in msg
    # Hint must point at the migration step.
    assert "migration" in msg.lower()


def test_router_repr_contains_table_names() -> None:
    """repr() helps debug DB introspection when a query hits the wrong table."""
    router = EmbeddingTableRouter(dim=1536)
    text = repr(router)
    assert "1536" in text
    assert "chunk_embeddings_d1536" in text
    assert "attribution_emb_d1536" in text
