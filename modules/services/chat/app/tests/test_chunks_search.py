"""Unit tests for the unified chunks_search tool.

Covers:
- type=null cross-corpus merge by score
- type filter routing to lecture branch only or library branch only
- single-language search (no cross-language fallback)
- top_k bounds
"""

from __future__ import annotations

from typing import Any

import pytest

from shruti_chat.agent.tools.chunks_search import chunks_search
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.entities import (
    Chunk,
    LibraryChunk,
    ScoredChunk,
    ScoredLibraryChunk,
)


class _StubCatalog:
    async def filter_track_ids(self, **_: Any) -> list[str] | None:
        return None  # no filter applied


class _StubEmbedder:
    async def embed_query(self, _query: str) -> list[float]:
        return [0.1, 0.2, 0.3]


class _StubChunkRepo:
    def __init__(
        self,
        lectures: list[ScoredChunk] | None = None,
        library: list[ScoredLibraryChunk] | None = None,
    ) -> None:
        self.lectures = lectures or []
        self.library = library or []
        self.search_calls: list[dict[str, Any]] = []
        self.library_calls: list[dict[str, Any]] = []

    async def search_by_embedding(
        self, _vec, *, eligible_track_ids=None, lang=None, top_k=8,
        excluded_track_ids=None,
    ) -> list[ScoredChunk]:
        self.search_calls.append({"lang": lang, "top_k": top_k})
        if lang is None:
            return self.lectures
        return [s for s in self.lectures if s.chunk.lang == lang]

    async def search_library_by_embedding(
        self, _vec, *, kinds, source_id=None, author_id=None,
        lang=None, date_from=None, date_to=None, top_k=8,
    ) -> list[ScoredLibraryChunk]:
        self.library_calls.append({"kinds": kinds, "lang": lang, "top_k": top_k})
        rows = [s for s in self.library if s.chunk.item_kind in kinds]
        if lang is not None:
            rows = [s for s in rows if s.chunk.lang == lang]
        return rows


def _lecture(track_id: str, score: float, lang: str = "ru") -> ScoredChunk:
    return ScoredChunk(
        chunk=Chunk(
            track_id=track_id, lang=lang,
            start_ms=0, end_ms=1000, text=f"text {track_id}",
            reference_source_id=None,
        ),
        score=score,
    )


def _verse(tokens: str, score: float, lang: str = "ru") -> ScoredLibraryChunk:
    return ScoredLibraryChunk(
        chunk=LibraryChunk(
            item_id=f"verse_{tokens}", item_kind="verse",
            source_id="BG", tokens=tokens,
            author_id=None, doc_date=None,
            lang=lang, segment_index=0,
            text=f"verse text {tokens}",
            addr_label=f"БГ {tokens}",
        ),
        score=score,
    )


async def test_type_null_merges_branches_by_score() -> None:
    repo = _StubChunkRepo(
        lectures=[_lecture("t1", 0.9), _lecture("t2", 0.4)],
        library=[_verse("2.13", 0.8), _verse("3.5", 0.5)],
    )
    rows = await chunks_search(
        query="x", type=None, lang=None, top_k=8,
        chunk_repo=repo, catalog_repo=_StubCatalog(),
        embedder=_StubEmbedder(), alias_map=TurnAliasMap(),
    )
    # Merged + sorted by score desc.
    scores = [r["score"] for r in rows]
    assert scores == sorted(scores, reverse=True)
    # Both classes represented.
    types = {r["type"] for r in rows}
    assert types == {"lecture", "verse"}


async def test_type_lecture_only_skips_library_branch() -> None:
    repo = _StubChunkRepo(
        lectures=[_lecture("t1", 0.9)],
        library=[_verse("2.13", 0.8)],  # should NOT be queried
    )
    rows = await chunks_search(
        query="x", type="lecture",
        chunk_repo=repo, catalog_repo=_StubCatalog(),
        embedder=_StubEmbedder(), alias_map=TurnAliasMap(),
    )
    assert all(r["type"] == "lecture" for r in rows)
    assert repo.library_calls == []  # library branch not called


async def test_type_verse_only_skips_lecture_branch() -> None:
    repo = _StubChunkRepo(
        lectures=[_lecture("t1", 0.9)],
        library=[_verse("2.13", 0.8)],
    )
    rows = await chunks_search(
        query="x", type="verse",
        chunk_repo=repo, catalog_repo=_StubCatalog(),
        embedder=_StubEmbedder(), alias_map=TurnAliasMap(),
    )
    assert all(r["type"] == "verse" for r in rows)
    assert repo.search_calls == []  # lecture branch not called


async def test_no_cross_language_fallback() -> None:
    # lang='ru' with only an 'en' lecture available → returns NOTHING.
    # Chunks are cited to the user verbatim (never LLM-translated), so we
    # never surface a foreign-language result; there is no lang=None relax.
    repo = _StubChunkRepo(
        lectures=[_lecture("t_en", 0.9, lang="en")],
        library=[],
    )
    rows = await chunks_search(
        query="x", type="lecture", lang="ru",
        chunk_repo=repo, catalog_repo=_StubCatalog(),
        embedder=_StubEmbedder(), alias_map=TurnAliasMap(),
    )
    assert rows == []
    # Exactly one attempt, in the requested language — never lang=None.
    langs_seen = [c["lang"] for c in repo.search_calls]
    assert langs_seen == ["ru"]


async def test_top_k_respected_after_merge() -> None:
    repo = _StubChunkRepo(
        lectures=[_lecture(f"t{i}", 0.9 - 0.01 * i) for i in range(10)],
        library=[_verse(f"{i}.1", 0.5 - 0.01 * i) for i in range(10)],
    )
    rows = await chunks_search(
        query="x", type=None, top_k=5,
        chunk_repo=repo, catalog_repo=_StubCatalog(),
        embedder=_StubEmbedder(), alias_map=TurnAliasMap(),
    )
    assert len(rows) == 5


async def test_unknown_type_returns_empty() -> None:
    repo = _StubChunkRepo(lectures=[_lecture("t1", 0.9)])
    rows = await chunks_search(
        query="x", type="not_a_real_type",
        chunk_repo=repo, catalog_repo=_StubCatalog(),
        embedder=_StubEmbedder(), alias_map=TurnAliasMap(),
    )
    assert rows == []
