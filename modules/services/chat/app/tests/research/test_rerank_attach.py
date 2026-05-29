"""Tests for `commentary_expansion.rerank_and_attach_commentaries`."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from shruti_chat.research.commentary_expansion import (
    rerank_and_attach_commentaries,
    _cosine,
)
from shruti_chat.research.models import Outline, Thesis


# ── helpers ─────────────────────────────────────────────────────────


@dataclass
class _LibChunk:
    item_id: str
    item_kind: str
    text: str
    lang: str
    addr_label: str = ""
    source_id: str = ""
    tokens: str = ""
    author_id: str | None = None
    doc_date: str | None = None
    segment_index: int = 0


@dataclass
class FakeChunkRepo:
    by_verse: dict[tuple[str, str], list[_LibChunk]] = field(default_factory=dict)

    async def get_chunks_by_verse(self, *, source_id, tokens, kinds, lang=None):
        return self.by_verse.get((source_id, tokens), [])


class FakeAliasMap:
    def __init__(self) -> None:
        self._next = 100  # high so we don't collide with base note indices
        self.captions: dict[int, str] = {}
        self.chunk_texts: dict[int, str] = {}

    def alias_chunk(self, *_a, **_k): return 0
    def alias_verse(self, *_a, **_k): return 0

    def alias_commentary(self, item_id, segment_index, *, addr_label, author_name, sentences):
        self._next += 1
        return self._next


class FakeCatalog:
    async def get_author_names(self, ids, *, lang):
        return {i: f"Author of {i}" for i in ids}


@dataclass
class FakeEmbedder:
    """Deterministic per-text embedding (1-hot 4-d). Lets us compute
    expected cosine scores without an LLM. `mapping` overrides text→vec
    for specific test setups."""

    mapping: dict[str, list[float]] = field(default_factory=dict)
    raise_on_call: bool = False
    calls: list[list[str]] = field(default_factory=list)

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        if self.raise_on_call:
            raise RuntimeError("embedder boom")
        return [self.mapping.get(t, [0.0, 0.0, 0.0, 0.0]) for t in texts]


def _verse_env(idx_unused: int, *, text: str, source_id: str, tokens: str, score: float = 0.7) -> dict:
    return {
        "type": "verse", "ref": 1, "label": f"{source_id} {tokens}",
        "text": text, "lang": "ru", "score": score,
        "meta": {"source_id": source_id, "tokens": tokens},
    }


def _lecture_env(*, text: str, score: float = 0.6) -> dict:
    return {
        "type": "lecture", "ref": 2, "label": "",
        "text": text, "lang": "ru", "score": score,
        "meta": {"start_ms": 0, "end_ms": 1000},
    }


def _commentary_env(*, text: str, item_id: str, score: float = 0.55) -> dict:
    return {
        "type": "commentary", "ref": 3, "label": "comm",
        "text": text, "lang": "ru", "score": score,
        "meta": {"source_id": "x", "tokens": "1.1", "item_id": item_id, "segment_index": 0},
    }


# ── _cosine helper ─────────────────────────────────────────────────


def test_cosine_perpendicular_is_zero():
    assert _cosine([1, 0, 0], [0, 1, 0]) == 0.0


def test_cosine_identical_is_one():
    assert _cosine([0.6, 0.8], [0.6, 0.8]) == pytest.approx(1.0)


def test_cosine_zero_vector_is_zero_not_error():
    """An embedder might return zeros for empty text — must not divide by 0."""
    assert _cosine([0, 0, 0], [1, 1, 1]) == 0.0
    assert _cosine([1, 1, 1], [0, 0, 0]) == 0.0


def test_cosine_dimension_mismatch_returns_zero():
    assert _cosine([1, 0], [1, 0, 0]) == 0.0


# ── rerank_and_attach_commentaries ─────────────────────────────────


@pytest.mark.asyncio
async def test_empty_outline_returns_unchanged():
    out, new = await rerank_and_attach_commentaries(
        Outline(theses=[]), [],
        chunk_repo=FakeChunkRepo(), embedder=FakeEmbedder(),
        alias_map=FakeAliasMap(), lang="ru",
    )
    assert out.theses == []
    assert new == []


@pytest.mark.asyncio
async def test_missing_embedder_returns_unchanged():
    """Graceful degrade: no embedder → planner's picks survive untouched."""
    outline = Outline(theses=[
        Thesis(thesis="some claim", supporting_notes=[1]),
    ])
    notes = [_lecture_env(text="x")]
    out, new = await rerank_and_attach_commentaries(
        outline, notes,
        chunk_repo=FakeChunkRepo(), embedder=None,
        alias_map=FakeAliasMap(), lang="ru",
    )
    assert out.theses[0].supporting_notes == [1]
    assert new == []


@pytest.mark.asyncio
async def test_thesis_without_verse_skips_commentary_fetch():
    """Pure lecture pool → no DB call, just rerank existing notes."""
    outline = Outline(theses=[
        Thesis(thesis="claim about karma", supporting_notes=[1, 2]),
    ])
    notes = [
        _lecture_env(text="lecture A on karma"),
        _lecture_env(text="lecture B on bhakti"),
    ]
    repo = FakeChunkRepo()  # empty
    embedder = FakeEmbedder(mapping={
        "claim about karma":   [1.0, 0.0, 0.0, 0.0],
        "lecture A on karma":  [0.9, 0.1, 0.0, 0.0],  # closer
        "lecture B on bhakti": [0.1, 0.9, 0.0, 0.0],
    })
    out, new = await rerank_and_attach_commentaries(
        outline, notes,
        chunk_repo=repo, embedder=embedder,
        alias_map=FakeAliasMap(), lang="ru",
    )
    assert new == []  # no commentaries fetched
    # Reranker picked index 1 (lecture A) as the closest to the thesis.
    assert out.theses[0].supporting_notes[0] == 1


@pytest.mark.asyncio
async def test_thesis_with_verse_fetches_and_attaches_commentaries():
    outline = Outline(theses=[
        Thesis(thesis="krishna protects devotee", supporting_notes=[1]),
    ])
    base_notes = [
        _verse_env(0, text="krishna verse", source_id="bg", tokens="9.22"),
    ]
    repo = FakeChunkRepo(by_verse={
        ("bg", "9.22"): [
            _LibChunk(
                item_id="comm_a", item_kind="commentary",
                text="commentary on krishna protecting",
                lang="ru", addr_label="BG 9.22",
                source_id="bg", tokens="9.22", author_id="prabhupada",
                segment_index=0,
            ),
        ],
    })
    embedder = FakeEmbedder(mapping={
        "krishna protects devotee":         [1.0, 0.0, 0.0, 0.0],
        "krishna verse":                    [0.7, 0.0, 0.0, 0.0],
        "commentary on krishna protecting": [0.95, 0.0, 0.0, 0.0],  # closer
    })
    out, new = await rerank_and_attach_commentaries(
        outline, base_notes,
        chunk_repo=repo, embedder=embedder,
        alias_map=FakeAliasMap(), lang="ru",
        catalog_repo=FakeCatalog(),
    )
    # One commentary fetched + reranked, picked as top.
    assert len(new) == 1
    assert new[0]["type"] == "commentary"
    # Reranker should rank commentary index (2 in 1-based, since base has 1) above verse (1).
    assert out.theses[0].supporting_notes[0] == 2  # commentary is 2nd in pool


@pytest.mark.asyncio
async def test_embedder_failure_returns_outline_with_fetched_commentaries_no_rerank():
    """If commentaries were fetched but embedder then fails: keep the
    commentaries (they're real material the synthesizer can show) but
    don't rewrite supporting_notes."""
    outline = Outline(theses=[
        Thesis(thesis="claim", supporting_notes=[1]),
    ])
    base_notes = [_verse_env(0, text="verse", source_id="bg", tokens="9.22")]
    repo = FakeChunkRepo(by_verse={
        ("bg", "9.22"): [_LibChunk(
            item_id="c", item_kind="commentary", text="comm text",
            lang="ru", addr_label="BG 9.22", source_id="bg", tokens="9.22",
        )],
    })
    embedder = FakeEmbedder(raise_on_call=True)
    out, new = await rerank_and_attach_commentaries(
        outline, base_notes,
        chunk_repo=repo, embedder=embedder,
        alias_map=FakeAliasMap(), lang="ru",
        catalog_repo=FakeCatalog(),
    )
    assert len(new) == 1  # commentary was fetched before embed call
    assert out.theses[0].supporting_notes == [1]  # original preserved


@pytest.mark.asyncio
async def test_top_k_per_thesis_respected():
    outline = Outline(theses=[
        Thesis(thesis="topic", supporting_notes=[1, 2, 3, 4, 5]),
    ])
    notes = [_lecture_env(text=f"lec {i}") for i in range(5)]
    embedder = FakeEmbedder(mapping={
        "topic": [1.0, 0.0, 0.0, 0.0],
        **{f"lec {i}": [0.5 + i * 0.05, 0.0, 0.0, 0.0] for i in range(5)},
    })
    out, _ = await rerank_and_attach_commentaries(
        outline, notes,
        chunk_repo=FakeChunkRepo(), embedder=embedder,
        alias_map=FakeAliasMap(), lang="ru",
        top_k_per_thesis=3,
    )
    assert len(out.theses[0].supporting_notes) == 3


@pytest.mark.asyncio
async def test_supporting_notes_indices_are_1_based():
    """Synthesizer's _format_tool_results enumerates with start=1, so
    indices in supporting_notes must be 1-based to match."""
    outline = Outline(theses=[
        Thesis(thesis="topic", supporting_notes=[1]),
    ])
    notes = [_lecture_env(text="lec A"), _lecture_env(text="lec B")]
    embedder = FakeEmbedder(mapping={
        "topic": [1.0, 0.0, 0.0, 0.0],
        "lec A": [0.5, 0.0, 0.0, 0.0],
        "lec B": [0.95, 0.0, 0.0, 0.0],  # B wins
    })
    out, _ = await rerank_and_attach_commentaries(
        outline, notes,
        chunk_repo=FakeChunkRepo(), embedder=embedder,
        alias_map=FakeAliasMap(), lang="ru",
    )
    assert out.theses[0].supporting_notes[0] == 2  # B is 1-based index 2


@pytest.mark.asyncio
async def test_commentary_dedup_against_base_notes():
    """If a commentary is already in base_notes (e.g. surfaced by ANN
    on its own), don't fetch a duplicate via address-keyed lookup."""
    outline = Outline(theses=[
        Thesis(thesis="topic", supporting_notes=[1, 2]),
    ])
    base_notes = [
        _verse_env(0, text="verse", source_id="bg", tokens="9.22"),
        _commentary_env(text="existing comm", item_id="comm_a"),
    ]
    # Repo returns the SAME commentary that's already in base_notes.
    repo = FakeChunkRepo(by_verse={
        ("bg", "9.22"): [_LibChunk(
            item_id="comm_a", item_kind="commentary",
            text="duplicate comm", lang="ru", addr_label="BG 9.22",
            source_id="bg", tokens="9.22", segment_index=0,
        )],
    })
    embedder = FakeEmbedder(mapping={
        "topic": [1.0, 0.0, 0.0, 0.0],
        "verse": [0.5, 0.0, 0.0, 0.0],
        "existing comm": [0.5, 0.0, 0.0, 0.0],
    })
    out, new = await rerank_and_attach_commentaries(
        outline, base_notes,
        chunk_repo=repo, embedder=embedder,
        alias_map=FakeAliasMap(), lang="ru",
        catalog_repo=FakeCatalog(),
    )
    # Duplicate was dropped — no new commentary appended.
    assert new == []


@pytest.mark.asyncio
async def test_log_runs_without_crash_with_enriched_fields():
    """Smoke check — enriched logs (per_thesis dict with cosine scores
    and type_mix) shouldn't crash structlog's pipeline. Real field-level
    verification lives in Langfuse traces after deploy."""
    outline = Outline(theses=[
        Thesis(thesis="topic A", supporting_notes=[1]),
        Thesis(thesis="topic B", supporting_notes=[2]),
    ])
    notes = [_lecture_env(text="A text"), _lecture_env(text="B text")]
    embedder = FakeEmbedder(mapping={
        "topic A": [1.0, 0.0, 0.0, 0.0],
        "topic B": [0.0, 1.0, 0.0, 0.0],
        "A text": [0.95, 0.0, 0.0, 0.0],
        "B text": [0.0, 0.95, 0.0, 0.0],
    })
    # If the new per_thesis log fields are malformed, structlog would
    # raise — the test would fail. Pass = the enriched log call works.
    await rerank_and_attach_commentaries(
        outline, notes,
        chunk_repo=FakeChunkRepo(), embedder=embedder,
        alias_map=FakeAliasMap(), lang="ru",
    )


@pytest.mark.asyncio
async def test_non_lecture_slot_swaps_in_commentary_when_picks_all_lectures():
    """1d: when the per-thesis top-K is all lectures but a strong (≥0.55)
    commentary sits just below, swap the weakest lecture for it so theses
    aren't lecture-monopolised. Swap keeps the slot count + 1-based indices."""
    outline = Outline(theses=[
        Thesis(thesis="topic", supporting_notes=[1, 2, 3]),
    ])
    base_notes = [
        _lecture_env(text="lec 0"),
        _lecture_env(text="lec 1"),
        _commentary_env(text="comm strong", item_id="comm_a"),
    ]
    embedder = FakeEmbedder(mapping={
        "topic":       [1.0, 0.0, 0.0, 0.0],
        "lec 0":       [1.0, 0.0, 0.0, 0.0],   # cos 1.0
        "lec 1":       [0.8, 0.6, 0.0, 0.0],   # cos 0.8
        "comm strong": [0.6, 0.8, 0.0, 0.0],   # cos 0.6 (≥0.55, below both lectures)
    })
    out, _ = await rerank_and_attach_commentaries(
        outline, base_notes,
        chunk_repo=FakeChunkRepo(), embedder=embedder,
        alias_map=FakeAliasMap(), lang="ru",
        catalog_repo=FakeCatalog(), top_k_per_thesis=2,
    )
    picks = out.theses[0].supporting_notes
    assert len(picks) == 2                 # slot count unchanged
    assert 3 in picks                      # commentary (1-based idx 3) swapped in
    assert 1 in picks                      # strongest lecture kept


@pytest.mark.asyncio
async def test_non_lecture_slot_no_swap_when_no_strong_non_lecture():
    """No swap when the only non-lecture is weak (<0.55) — never displace a
    real lecture for junk."""
    outline = Outline(theses=[
        Thesis(thesis="topic", supporting_notes=[1, 2, 3]),
    ])
    base_notes = [
        _lecture_env(text="lec 0"),
        _lecture_env(text="lec 1"),
        _commentary_env(text="comm weak", item_id="comm_b"),
    ]
    embedder = FakeEmbedder(mapping={
        "topic":     [1.0, 0.0, 0.0, 0.0],
        "lec 0":     [1.0, 0.0, 0.0, 0.0],
        "lec 1":     [0.9, 0.436, 0.0, 0.0],
        "comm weak": [0.3, 0.954, 0.0, 0.0],   # cos ~0.3 < 0.55
    })
    out, _ = await rerank_and_attach_commentaries(
        outline, base_notes,
        chunk_repo=FakeChunkRepo(), embedder=embedder,
        alias_map=FakeAliasMap(), lang="ru",
        catalog_repo=FakeCatalog(), top_k_per_thesis=2,
    )
    assert out.theses[0].supporting_notes == [1, 2]  # untouched lectures
