"""Unit tests for research.commentary_expansion.

Fakes mimic the real LibraryChunk shape just enough for library_to_envelope
to work — see agent/tools/_envelope.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from lectorium_chat.research.commentary_expansion import (
    expand_verses_with_commentaries,
)


# ---- fakes ----------------------------------------------------------------


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


class FakeChunkRepo:
    def __init__(self, by_addr: dict[tuple[str, str, str | None], list[_LibChunk]] | None = None) -> None:
        # Keyed by (source_id, tokens, lang) — lang=None for the fallback bucket.
        self.by_addr = by_addr or {}
        self.calls: list[tuple[str, str, str | None]] = []

    async def get_chunks_by_verse(self, *, source_id, tokens, kinds, lang=None):
        self.calls.append((source_id, tokens, lang))
        assert kinds == ["commentary"], f"unexpected kinds={kinds}"
        return list(self.by_addr.get((source_id, tokens, lang), []))


class FakeAliasMap:
    def __init__(self) -> None:
        self._verse: dict[tuple, int] = {}
        self._counter = 0

    def alias_verse(self, source_id, tokens, addr_label):
        key = (source_id, tokens)
        if key in self._verse:
            return self._verse[key]
        self._counter += 1
        self._verse[key] = self._counter
        return self._counter

    def alias_commentary(self, item_id, segment_index, *, addr_label, author_name, sentences, kind="commentary"):
        self._counter += 1
        return self._counter


def _verse_env(source_id: str, tokens: str, *, score: float = 0.7) -> dict[str, Any]:
    return {
        "type": "verse",
        "ref": 1,
        "label": f"BG {tokens}",
        "text": f"verse {tokens}",
        "lang": "en",
        "score": score,
        "meta": {"source_id": source_id, "tokens": tokens},
    }


# ---- tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_verses_returns_empty():
    repo = FakeChunkRepo()
    out = await expand_verses_with_commentaries(
        [{"type": "lecture", "text": "x", "meta": {}}],
        chunk_repo=repo, alias_map=FakeAliasMap(), lang="en",
    )
    assert out == []
    assert repo.calls == []


@pytest.mark.asyncio
async def test_one_verse_pulls_commentaries_and_inherits_score():
    repo = FakeChunkRepo(by_addr={
        ("BG", "2.13", "en"): [
            _LibChunk("doc_a", "commentary", "Prabhupada says", "en",
                      addr_label="BG 2.13", source_id="BG", tokens="2.13",
                      author_id="prabhupada", segment_index=0),
            _LibChunk("doc_b", "commentary", "Vishvanatha says", "en",
                      addr_label="BG 2.13", source_id="BG", tokens="2.13",
                      author_id="vishvanatha", segment_index=0),
        ],
    })
    out = await expand_verses_with_commentaries(
        [_verse_env("BG", "2.13", score=0.80)],
        chunk_repo=repo, alias_map=FakeAliasMap(), lang="en",
    )
    assert len(out) == 2
    assert all(e["type"] == "commentary" for e in out)
    # Score = parent - 0.05
    assert out[0]["score"] == pytest.approx(0.75)
    assert out[1]["score"] == pytest.approx(0.75)


@pytest.mark.asyncio
async def test_cap_respected_with_author_diversity_first():
    chunks = [
        _LibChunk(f"doc_{i}", "commentary", "x", "en",
                  addr_label="BG 2.13", source_id="BG", tokens="2.13",
                  author_id=author, segment_index=seg)
        for i, (author, seg) in enumerate([
            ("a", 0), ("a", 1), ("a", 2),
            ("b", 0), ("b", 1),
            ("c", 0),
            ("d", 0),
        ])
    ]
    repo = FakeChunkRepo(by_addr={("BG", "2.13", "en"): chunks})
    out = await expand_verses_with_commentaries(
        [_verse_env("BG", "2.13")],
        chunk_repo=repo, alias_map=FakeAliasMap(), lang="en",
        max_commentaries_per_verse=4,
    )
    assert len(out) == 4
    # First 4 should be the 4 distinct authors (a, b, c, d), not 4 segments of "a"
    authors_picked = [e["meta"]["author_id"] for e in out]
    assert sorted(authors_picked) == ["a", "b", "c", "d"]


@pytest.mark.asyncio
async def test_lang_fallback_when_strict_lang_empty():
    repo = FakeChunkRepo(by_addr={
        ("BG", "2.13", "ru"): [],
        ("BG", "2.13", None): [
            _LibChunk("doc_a", "commentary", "EN purport", "en",
                      addr_label="BG 2.13", source_id="BG", tokens="2.13",
                      author_id="prabhupada", segment_index=0),
        ],
    })
    out = await expand_verses_with_commentaries(
        [_verse_env("BG", "2.13")],
        chunk_repo=repo, alias_map=FakeAliasMap(), lang="ru",
    )
    assert len(out) == 1
    assert out[0]["lang"] == "en"
    # Two lookups: strict ru → fallback None
    assert repo.calls == [("BG", "2.13", "ru"), ("BG", "2.13", None)]


@pytest.mark.asyncio
async def test_dedup_when_same_commentary_under_two_verses():
    shared = _LibChunk("doc_shared", "commentary", "shared", "en",
                       addr_label="BG 2.13", source_id="BG", tokens="2.13",
                       author_id="x", segment_index=0)
    repo = FakeChunkRepo(by_addr={
        ("BG", "2.13", "en"): [shared],
        ("BG", "2.14", "en"): [shared],
    })
    out = await expand_verses_with_commentaries(
        [_verse_env("BG", "2.13"), _verse_env("BG", "2.14")],
        chunk_repo=repo, alias_map=FakeAliasMap(), lang="en",
    )
    assert len(out) == 1


@pytest.mark.asyncio
async def test_dedup_against_input_commentary_envelopes():
    # The same commentary chunk already showed up via fanout.
    existing = {
        "type": "commentary",
        "ref": None,
        "text": "already here",
        "lang": "en",
        "score": 0.6,
        "meta": {"item_id": "doc_a", "segment_index": 0,
                 "source_id": "BG", "tokens": "2.13"},
    }
    repo = FakeChunkRepo(by_addr={
        ("BG", "2.13", "en"): [
            _LibChunk("doc_a", "commentary", "dup", "en",
                      addr_label="BG 2.13", source_id="BG", tokens="2.13",
                      author_id="x", segment_index=0),
        ],
    })
    out = await expand_verses_with_commentaries(
        [_verse_env("BG", "2.13"), existing],
        chunk_repo=repo, alias_map=FakeAliasMap(), lang="en",
    )
    assert out == []


@pytest.mark.asyncio
async def test_on_event_emits_one_research_source_per_commentary():
    repo = FakeChunkRepo(by_addr={
        ("BG", "2.13", "en"): [
            _LibChunk("doc_a", "commentary", "p1", "en",
                      addr_label="BG 2.13", source_id="BG", tokens="2.13",
                      author_id="prabhupada", segment_index=0),
            _LibChunk("doc_b", "commentary", "v1", "en",
                      addr_label="BG 2.13", source_id="BG", tokens="2.13",
                      author_id="vishvanatha", segment_index=0),
        ],
    })
    events: list[tuple[str, dict[str, Any]]] = []
    out = await expand_verses_with_commentaries(
        [_verse_env("BG", "2.13")],
        chunk_repo=repo, alias_map=FakeAliasMap(), lang="en",
        on_event=lambda t, d: events.append((t, d)),
    )
    assert len(out) == 2
    assert len(events) == 2
    assert all(t == "research_source" for t, _ in events)
    assert all(d["kind"] == "commentary" for _, d in events)


@pytest.mark.asyncio
async def test_repo_error_does_not_break_helper():
    class _RaisingRepo:
        async def get_chunks_by_verse(self, **_kwargs):
            raise RuntimeError("db down")

    out = await expand_verses_with_commentaries(
        [_verse_env("BG", "2.13")],
        chunk_repo=_RaisingRepo(), alias_map=FakeAliasMap(), lang="en",
    )
    assert out == []


@pytest.mark.asyncio
async def test_verse_without_meta_skipped():
    out = await expand_verses_with_commentaries(
        [{"type": "verse", "meta": {}, "score": 0.7}],
        chunk_repo=FakeChunkRepo(), alias_map=FakeAliasMap(), lang="en",
    )
    assert out == []
