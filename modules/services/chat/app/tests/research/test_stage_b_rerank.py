"""Stage B (per-thesis grounding) rerank tests.

Covers `rerank_and_attach_commentaries` (Stage 1) and `augment_thin_theses`
(Stage 2) with a stub cross-encoder: selection follows the rerank order
over `t.thesis`, while thin-detection stays on cosine, and `reranker=None`
reproduces the cosine selection verbatim.
"""

from __future__ import annotations

from typing import Any

import pytest

from shruti_chat.research.commentary_expansion import rerank_and_attach_commentaries
from shruti_chat.research.models import Outline, Thesis
from shruti_chat.research.thesis_augmentation import augment_thin_theses


# ---- fakes ----------------------------------------------------------------


class FakeEmbedder:
    """Deterministic embeddings: each text maps to a 1-hot-ish vector so
    cosine is a stable function of (thesis, note) text identity."""

    def __init__(self, vec_by_text: dict[str, list[float]] | None = None) -> None:
        self.vec_by_text = vec_by_text or {}

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self.vec_by_text.get(t, [0.1, 0.1, 0.1]) for t in texts]

    async def embed_queries(self, texts: list[str]) -> list[list[float]]:
        return await self.embed_documents(texts)


class FakeChunkRepo:
    async def get_chunks_by_verse(self, **_kwargs):
        return []


class FakeCatalogRepo:
    async def filter_track_ids(self, **_kwargs):
        return None

    async def get_author_names(self, ids, *, lang):
        return {}


class StubReranker:
    name = "stub"

    def __init__(self, score_by_text: dict[str, float]) -> None:
        self.score_by_text = score_by_text
        self.calls: list[tuple[str, list[str]]] = []

    async def rerank(self, query, documents, *, top_k=None):
        self.calls.append((query, list(documents)))
        scored = [(i, self.score_by_text.get(d, 0.0)) for i, d in enumerate(documents)]
        scored.sort(key=lambda t: t[1], reverse=True)
        if top_k is not None:
            scored = scored[:top_k]
        return scored


class RaisingReranker:
    name = "boom"

    async def rerank(self, query, documents, *, top_k=None):
        raise RuntimeError("vendor down")


def _note(ref: int, text: str, kind: str = "lecture", score: float = 0.6) -> dict[str, Any]:
    return {"type": kind, "ref": ref, "text": text, "score": score, "meta": {}}


def _outline(thesis: str, supporting: list[int]) -> Outline:
    return Outline(theses=[Thesis(thesis=thesis, supporting_notes=supporting)])


# ---- Stage 1 ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_stage1_rerank_owns_selection():
    base_notes = [_note(1, "A"), _note(2, "B"), _note(3, "C")]
    outline = _outline("claim", [1, 2, 3])
    rr = StubReranker({"A": 0.1, "B": 0.9, "C": 0.5})
    enriched, _new = await rerank_and_attach_commentaries(
        outline, base_notes,
        chunk_repo=FakeChunkRepo(), embedder=FakeEmbedder(),
        alias_map=None, lang="ru", catalog_repo=FakeCatalogRepo(),
        top_k_per_thesis=2, reranker=rr,
    )
    # Reranker anchored on the thesis statement alone.
    assert rr.calls and rr.calls[0][0] == "claim"
    # Top-2 by rerank: B (0.9), C (0.5) → 1-based pool indices 2, 3.
    assert enriched.theses[0].supporting_notes == [2, 3]


@pytest.mark.asyncio
async def test_stage1_none_parity_uses_cosine():
    # cosine path: thesis vec equals note "A" vec → A is the top cosine pick.
    vecs = {
        "claim": [1.0, 0.0, 0.0],
        "A": [1.0, 0.0, 0.0],   # cosine 1.0 with claim
        "B": [0.0, 1.0, 0.0],   # cosine 0.0
        "C": [0.0, 0.0, 1.0],   # cosine 0.0
    }
    base_notes = [_note(1, "A"), _note(2, "B"), _note(3, "C")]
    outline = _outline("claim", [1, 2, 3])
    enriched, _new = await rerank_and_attach_commentaries(
        outline, base_notes,
        chunk_repo=FakeChunkRepo(), embedder=FakeEmbedder(vecs),
        alias_map=None, lang="ru", catalog_repo=FakeCatalogRepo(),
        top_k_per_thesis=1, reranker=None,
    )
    assert enriched.theses[0].supporting_notes == [1]   # cosine top = A


@pytest.mark.asyncio
async def test_stage1_rerank_failure_falls_back_to_cosine():
    vecs = {"claim": [1.0, 0.0], "A": [1.0, 0.0], "B": [0.0, 1.0]}
    base_notes = [_note(1, "A"), _note(2, "B")]
    outline = _outline("claim", [1, 2])
    enriched, _new = await rerank_and_attach_commentaries(
        outline, base_notes,
        chunk_repo=FakeChunkRepo(), embedder=FakeEmbedder(vecs),
        alias_map=None, lang="ru", catalog_repo=FakeCatalogRepo(),
        top_k_per_thesis=1, reranker=RaisingReranker(),
    )
    # Reranker raised → cosine selection (A, the parallel vector).
    assert enriched.theses[0].supporting_notes == [1]


# ---- Stage 2 ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_stage2_rerank_reorders_supporting_notes():
    # Thesis is "thin" on cosine (all notes orthogonal) → Stage 2 fires.
    # Fresh fanout returns nothing here; the rerank reorders the existing
    # supporting_notes so we can assert the selection follows rerank order.
    vecs = {"claim": [1.0, 0.0, 0.0], "A": [0.0, 1.0, 0.0], "B": [0.0, 0.0, 1.0]}
    base_notes = [_note(1, "A"), _note(2, "B")]
    outline = _outline("claim", [1, 2])

    class _EmptyFanoutRepo:
        async def search_by_embedding(self, *a, **k):
            return []

        async def search_library_by_embedding(self, *a, **k):
            return []

    rr = StubReranker({"A": 0.2, "B": 0.9})
    enriched, _fresh = await augment_thin_theses(
        outline, base_notes,
        chunk_repo=_EmptyFanoutRepo(), embedder=FakeEmbedder(vecs),
        alias_map=None, catalog_repo=FakeCatalogRepo(), lang="ru",
        router_args={}, top_k_per_thesis=2, reranker=rr,
    )
    # rerank prefers B (0.9) then A (0.2).
    assert enriched.theses[0].supporting_notes == [2, 1]


@pytest.mark.asyncio
async def test_stage2_none_parity_keeps_cosine_order():
    vecs = {"claim": [1.0, 0.0, 0.0], "A": [0.0, 1.0, 0.0], "B": [0.0, 0.0, 1.0]}
    base_notes = [_note(1, "A"), _note(2, "B")]
    outline = _outline("claim", [1, 2])

    class _EmptyFanoutRepo:
        async def search_by_embedding(self, *a, **k):
            return []

        async def search_library_by_embedding(self, *a, **k):
            return []

    enriched, _fresh = await augment_thin_theses(
        outline, base_notes,
        chunk_repo=_EmptyFanoutRepo(), embedder=FakeEmbedder(vecs),
        alias_map=None, catalog_repo=FakeCatalogRepo(), lang="ru",
        router_args={}, top_k_per_thesis=2, reranker=None,
    )
    # No reranker → cosine selection survives (both notes, cosine order).
    assert set(enriched.theses[0].supporting_notes) == {1, 2}
