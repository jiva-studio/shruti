"""Naming a book must not delete the book from the answer.

«Что Шримад-Бхагаватам говорит о карме?» was answered on production from 213
lecture fragments and ZERO verses, purports or chapters. The same question with
no book named retrieved 306 of them. The cause is one spelling difference: the
router extracts «ШБ» → `source_id="SB"`, and every chunk-level lane compares that
against `chunks.source_id`, which holds `source_0OX6Db6QpdJ4`. `c.source_id = 'SB'`
is not a loose filter, it is an empty one — and it fired on exactly the questions
that were ABOUT scripture.

Two layers, tested here because either alone leaves a hole:

- the router resolves the code to the catalog id ONCE, so every hop downstream
  reads one already-correct value (five of them read it, three differently);
- the lanes that talk to `chunks` refuse a value that cannot match, so an
  unresolvable code searches every book instead of none.

The lecture lane keeps the raw value on purpose: `filter_track_ids` resolves
short codes itself, and that is the path a book-scoped LECTURE search rides.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from shruti_chat.application.source_lookup import resolve_source_id
from shruti_chat.domain.source_ids import chunk_source_filter, is_opaque_source_id


_OPAQUE = "source_NoY8sAlXF1IT"


# ── the rule itself ───────────────────────────────────────────────────────


@pytest.mark.parametrize("value", [_OPAQUE, "source_x"])
def test_a_catalog_id_reaches_the_chunk_filter(value: str) -> None:
    assert is_opaque_source_id(value)
    assert chunk_source_filter(value) == value


@pytest.mark.parametrize("value", ["SB", "БГ", "Gita", "", None])
def test_what_cannot_match_is_dropped_not_passed_through(value: str | None) -> None:
    # Searching every book is a worse answer than the right one and a far better
    # one than "the corpus has nothing", which is what the code used to produce.
    assert not is_opaque_source_id(value)
    assert chunk_source_filter(value) is None


# ── resolution (application) ──────────────────────────────────────────────


@dataclass
class _Hit:
    id: str
    confidence: float


class _Catalog:
    def __init__(self, hits: list[_Hit] | None = None) -> None:
        self._hits = hits or []
        self.calls: list[tuple[str, str]] = []

    async def resolve(self, kind, text, *, lang=None, limit=1):
        self.calls.append((kind, text))
        return self._hits[:limit]


async def test_a_short_code_becomes_the_catalog_id() -> None:
    catalog = _Catalog([_Hit(_OPAQUE, 0.95)])
    assert await resolve_source_id(catalog, "SB") == _OPAQUE
    assert catalog.calls == [("source", "SB")]


async def test_a_catalog_id_costs_no_lookup() -> None:
    catalog = _Catalog()
    assert await resolve_source_id(catalog, _OPAQUE) == _OPAQUE
    assert catalog.calls == []


async def test_a_weak_match_resolves_to_nothing() -> None:
    # The resolved id drives a FILTER, so a fuzzy near-miss would answer about a
    # different scripture — worse than not narrowing at all.
    assert await resolve_source_id(_Catalog([_Hit(_OPAQUE, 0.4)]), "SB") is None


async def test_an_unknown_book_resolves_to_nothing() -> None:
    assert await resolve_source_id(_Catalog([]), "Zohar") is None


async def test_a_broken_catalog_resolves_to_nothing() -> None:
    class _Broken:
        async def resolve(self, *_a, **_kw):
            raise RuntimeError("catalog missing")

    assert await resolve_source_id(_Broken(), "SB") is None


@pytest.mark.parametrize("value", ["", "   ", None])
async def test_nothing_named_asks_nothing(value: str | None) -> None:
    catalog = _Catalog([_Hit(_OPAQUE, 0.9)])
    assert await resolve_source_id(catalog, value) is None
    assert catalog.calls == []


# ── the wire: what the lanes actually receive ─────────────────────────────


class _Recorder:
    """Captures the source filter each lane was given."""

    def __init__(self) -> None:
        self.library: list[Any] = []
        self.lexical: list[Any] = []
        self.track_filter: list[Any] = []

    async def search_by_embedding(self, *_a, **_kw):
        return []

    async def search_library_by_embedding(self, _vec, *, kinds, **kw):
        self.library.append(kw.get("source_id"))
        return []

    async def search_chunks_lexical(self, _q, _vec, *, kinds, **kw):
        self.lexical.append(kw.get("source_id"))
        return []

    async def get_chunks_by_addr_label(self, *_a, **_kw):
        return []


class _CatalogRepo:
    def __init__(self, seen: list[Any]) -> None:
        self._seen = seen

    async def filter_track_ids(self, **kw):
        self._seen.append(kw.get("source_id"))
        return None

    async def get_author_names(self, ids, *, lang=None):
        return {}


class _Embedder:
    async def embed_queries(self, texts):
        return [[0.0] * 8 for _ in texts]


class _Reranker:
    async def rerank(self, query, texts, top_k=None):
        return [(i, 1.0) for i in range(len(texts))]


async def _fanout(book_id: str) -> tuple[_Recorder, list[Any]]:
    from shruti_chat.research.corpus_fanout import fanout_search_with_boost
    from tests.research.test_corpus_fanout import FakeAliasMap

    repo = _Recorder()
    seen: list[Any] = []
    await fanout_search_with_boost(
        [(0, "карма")],
        embedder=_Embedder(),
        chunk_repo=repo,
        catalog_repo=_CatalogRepo(seen),
        alias_map=FakeAliasMap(),
        lang="ru",
        book_id=book_id,
        reranker=_Reranker(),
        rerank_query="карма",
    )
    return repo, seen


async def test_a_short_code_never_reaches_the_library_lanes() -> None:
    repo, tracks_seen = await _fanout("SB")
    # Both scripture lanes: no filter beats a filter that matches nothing.
    assert repo.library == [None, None]
    assert repo.lexical == [None]
    # The LECTURE side still narrows by the book — `filter_track_ids` resolves
    # short codes itself, so giving it up would lose a filter that works.
    assert tracks_seen == ["SB"]


async def test_a_catalog_id_does_reach_the_library_lanes() -> None:
    repo, tracks_seen = await _fanout(_OPAQUE)
    assert repo.library == [_OPAQUE, _OPAQUE]
    assert repo.lexical == [_OPAQUE]
    assert tracks_seen == [_OPAQUE]


async def test_the_planners_second_stage_follows_the_same_rule() -> None:
    from shruti_chat.research.thesis_augmentation import _fresh_fanout_for_thesis

    repo = _Recorder()
    seen: list[Any] = []
    await _fresh_fanout_for_thesis(
        [0.0] * 8,
        chunk_repo=repo,
        catalog_repo=_CatalogRepo(seen),
        router_args={"source_id": "SB"},
        lang="ru",
        top_k=4,
    )
    assert repo.library == [None]
    assert seen == ["SB"]


def test_locate_asks_the_same_question_of_the_same_helper() -> None:
    """`locate` had this rule first, spelled by hand. Two copies of an invariant
    drift; this pins that it now reads the shared one."""
    import inspect

    from shruti_chat.research import locate

    src = inspect.getsource(locate.run_locate)
    assert "chunk_source_filter(router_args.get(\"source_id\"))" in src
    assert "startswith(\"source_\")" not in src
