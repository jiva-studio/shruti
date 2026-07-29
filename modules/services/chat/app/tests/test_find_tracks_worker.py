"""Unit tests for agent.graph.nodes.find_tracks_worker — the deterministic
lecture-search node (intent=find_track).

The worker emits everything straight to the SSE writer (no synthesizer), so
the tests capture the writer event stream and assert on its structure: the
per-lecture description + server-resolved card payload + verbatim cite, the
relevance floor, the catalog filter, and the action-before-marker ordering.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes import find_tracks_worker as ftw
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain.entities import Chunk, ResolvedEntity, ScoredChunk, Track


@dataclass
class _Ctx:
    embedder: Any | None = None
    chunk_repo: Any | None = None
    catalog_repo: Any | None = None
    llm: Any | None = None
    aliases: TurnAliasMap = field(default_factory=TurnAliasMap)
    track_display_cache: dict = field(default_factory=dict)
    lang: str = "ru"
    translate_citations: bool = False
    translator: Any | None = None
    request_id: str = "req-test"
    kv_cache: Any | None = None


@dataclass
class _Runtime:
    context: _Ctx


class _Embedder:
    async def embed_query(self, text: str) -> list[float]:
        return [0.1, 0.2, 0.3]


class _ChunkRepo:
    def __init__(self, results: list[list[ScoredChunk]]) -> None:
        self._results = results
        self.calls = 0

    async def search_by_embedding(self, embedding, *, eligible_track_ids, lang, top_k):
        i = min(self.calls, len(self._results) - 1)
        self.calls += 1
        return self._results[i]


def _track(tid: str, title: str | None) -> Track:
    return Track(
        id=tid, title=title, lang="ru", date="1976-01-01",
        author_id="a1", author_name="Prabhupada", location_id=None, location_name=None,
        tag_ids=(), tag_names=(), duration_ms=None, references=(),
    )


class _Catalog:
    def __init__(
        self, *, titles=None, descriptions=None, eligible=None, sources=None,
        ref_tracks=None, authors=None,
    ) -> None:
        # authors: {query_text: (id, confidence)} for the author resolve.
        self._authors = authors or {}
        self._titles = dict(titles or {})
        self._descriptions = descriptions or {}
        self._eligible = eligible
        # opaque-id → short label, for source_short_label (exact id match, no norm)
        self._sources = sources or {}
        # Tracks returned by the deterministic ref-index probe (list_tracks).
        self._ref_tracks = ref_tracks or []
        for t in self._ref_tracks:
            self._titles.setdefault(t.id, t.title)
        self.filter_kwargs: dict = {}

    async def filter_track_ids(self, **kwargs):
        self.filter_kwargs = kwargs
        return self._eligible

    async def list_tracks(self, **kwargs):
        # The ref-index probe: return the configured lectures regardless of the
        # exact ref window (the parsing is covered by _ref_filter's own tests).
        return list(self._ref_tracks)

    async def get_outline(self, track_id, lang):
        return ("[]", self._descriptions.get(track_id))

    async def get_track(self, track_id, *, lang):
        # A track absent from `_titles` is "not in the published catalog".
        if track_id not in self._titles:
            return None
        return _track(track_id, self._titles[track_id])

    async def resolve(self, kind, text, *, lang, limit):
        # Emulate the abbrev→entity fuzzy resolve: "SB" (en) → opaque id, whose
        # extra.short_name is the EN abbrev (resolve matched the en side).
        if kind == "source":
            opaque = {"SB": "source_SB", "BG": "source_BG"}.get(text.strip().upper())
            if opaque:
                return [
                    ResolvedEntity(
                        id=opaque, full_name="Source",
                        confidence=1.0, extra={"short_name": text.strip().upper()},
                    )
                ]
        if kind == "author" and text in self._authors:
            aid, conf = self._authors[text]
            return [ResolvedEntity(id=aid, full_name=text, confidence=conf, extra={})]
        return []

    async def source_short_label(self, source_id, *, lang):
        # Localized label BY opaque id — ru gets "ШБ", not the en "SB".
        loc = {
            "source_SB": {"ru": "ШБ", "en": "SB"},
            "source_BG": {"ru": "БГ", "en": "BG"},
        }
        by_id = self._sources.get(source_id) or loc.get(source_id)
        if isinstance(by_id, dict):
            return by_id.get(lang) or by_id.get("en")
        return by_id


class _FakeLLM:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.situations: list[str] = []

    async def structured_output(self, messages, schema, *, run_name=None, model=None, callbacks=None):
        # Only the localized clarify/empty reply (LocalizedReply — line+chips)
        # still uses structured_output; the per-card blurb + intro are plain
        # text now (see `text_completion`).
        self.calls.append(run_name or "")
        situation = messages[-1]["content"]
        self.situations.append(situation)
        # A deterministic stand-in: a marker line + one chip, so tests can
        # assert the localized path ran and a chip was emitted, without
        # depending on real LLM phrasing.
        return schema(line=f"LINE[{run_name}]", chips=["CHIP"])

    async def text_completion(self, messages, *, model=None, run_name=None):
        self.calls.append(run_name or "")
        return f"prose[{run_name}]"


def _sc(track_id: str, start: int, score: float, text: str) -> ScoredChunk:
    return ScoredChunk(
        chunk=Chunk(
            track_id=track_id, lang="ru", start_ms=start, end_ms=start + 1000,
            text=text, reference_source_id=None,
        ),
        score=score,
    )


@pytest.fixture
def _events(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    captured: list[dict] = []
    monkeypatch.setattr(ftw, "get_stream_writer", lambda: captured.append)
    return captured


class _ProseRaisingLLM(_FakeLLM):
    """Raises on the prose calls (per-lecture description / intro), like a
    flaky cheap model / exhausted fallback — the exact prod crash to guard."""

    async def text_completion(self, messages, *, model=None, run_name=None):
        if run_name in ("find_tracks_description", "find_tracks_intro"):
            raise RuntimeError("llm_text: provider unavailable")
        return await super().text_completion(messages, model=model, run_name=run_name)


async def test_description_parse_failure_does_not_crash_the_turn(_events) -> None:
    # A flaky cheap-model parse miss on a card's blurb (and the intro) used to
    # propagate out of asyncio.gather and null the whole find_track turn. Now it
    # degrades: cards still render (without description / lead-in), no exception.
    chunks = [_sc("t1", 70000, 0.9, "t1 quote"), _sc("t2", 80000, 0.6, "t2 quote")]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks]),
        catalog_repo=_Catalog(titles={"t1": "Лекция А", "t2": "Лекция Б"},
                              descriptions={"t1": "d", "t2": "d"}),
        llm=_ProseRaisingLLM(),
    )
    out = await ftw.find_tracks_worker_node(
        {"user_query": "vrindavan conversations", "extracted_args": {}}, _Runtime(ctx)
    )
    assert out == {}  # completed, did not raise
    card_ids = [
        e["data"]["payload"]["track_id"]
        for e in _events if e["type"] == "action" and e["data"]["kind"] == "card"
    ]
    assert card_ids == ["t1", "t2"]  # cards still served despite the parse failures


async def test_emits_description_card_and_verbatim_quote(_events) -> None:
    chunks = [
        _sc("t1", 65000, 0.7, "t1 weaker"),
        _sc("t1", 70000, 0.9, "t1 best quote"),
        _sc("t2", 80000, 0.6, "t2 quote"),
    ]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks]),
        catalog_repo=_Catalog(
            titles={"t1": "Лекция А", "t2": "Лекция Б"},
            descriptions={"t1": "описание А", "t2": "описание Б"},
        ),
        llm=_FakeLLM(),
    )
    out = await ftw.find_tracks_worker_node(
        {"user_query": "очищение сердца", "extracted_args": {}}, _Runtime(ctx)
    )
    assert out == {}

    actions = [e for e in _events if e["type"] == "action"]
    cite_actions = [a for a in actions if a["data"]["kind"] == "cite_transcript"]
    card_actions = [a for a in actions if a["data"]["kind"] == "card"]

    # One card + one cite per lecture, ranked t1 then t2, verbatim quote text.
    assert [a["data"]["payload"]["track_id"] for a in card_actions] == ["t1", "t2"]
    assert [a["data"]["payload"].get("track_title") for a in card_actions] == ["Лекция А", "Лекция Б"]
    assert [a["data"]["payload"]["text"] for a in cite_actions] == ["t1 best quote", "t2 quote"]

    full = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert "[card:t1]" in full and "[card:t2]" in full
    assert "[cite:t1@70000-71000]" in full
    assert "###" not in full  # descriptions are paragraphs, NOT headings

    llm: _FakeLLM = ctx.llm
    assert "find_tracks_intro" in llm.calls
    assert llm.calls.count("find_tracks_description") == 2


async def test_card_and_cite_actions_precede_their_markers(_events) -> None:
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.9, "quote")]]),
        catalog_repo=_Catalog(titles={"t1": "Лекция"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node({"user_query": "x", "extracted_args": {}}, _Runtime(ctx))
    kinds = [(e["type"], e["data"].get("kind")) for e in _events]
    card_idx = kinds.index(("action", "card"))
    cite_idx = kinds.index(("action", "cite_transcript"))
    marker_idx = next(
        i for i, e in enumerate(_events)
        if e["type"] == "delta" and "[card:t1]" in e["data"]["text"]
    )
    assert card_idx < marker_idx and cite_idx < marker_idx


async def test_below_floor_results_dropped(_events) -> None:
    # Best chunk 0.30 < _MIN_SCORE → no lectures → just the empty intro line.
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.30, "weak")]]),
        catalog_repo=_Catalog(titles={"t1": "Лекция"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node({"user_query": "x", "extracted_args": {}}, _Runtime(ctx))
    assert not [e for e in _events if e["type"] == "action"]


async def test_bare_ref_probe_serves_lectures_the_embedding_missed(_events) -> None:
    # "sb 1.2.6-1.2.18" → semantic search returns 0 (a bare ref embeds to
    # noise), but the deterministic ref-index HAS lectures. Probe it and SERVE
    # those lectures (cards) instead of dead-ending, plus a "show verses" chip.
    # Uses the LIVE path: the router emits source_id as the abbreviation "SB".
    refs = [_track("r1", "Ценность жизни"), _track("r2", "Служите Богу")]
    llm = _FakeLLM()
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[]]),  # semantic: zero
        catalog_repo=_Catalog(ref_tracks=refs),  # ref-index: two lectures
        llm=llm,
        lang="ru",
    )
    out = await ftw.find_tracks_worker_node(
        {
            "user_query": "sb 1.2.6-1.2.18",
            "extracted_args": {"source_id": "SB", "tokens": "1.2.6-1.2.18"},
        },
        _Runtime(ctx),
    )
    assert out == {}
    text = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    card_ids = [
        e["data"]["payload"]["track_id"]
        for e in _events if e["type"] == "action" and e["data"]["kind"] == "card"
    ]
    assert card_ids == ["r1", "r2"]                     # served the found lectures
    assert "[card:r1]" in text and "[card:r2]" in text
    # Lead-in + verses chip are LLM-localized (any language), not hardcoded.
    assert "LINE[localized_reply]" in text
    assert "[followup:CHIP]" in text
    # The resolved ref label ("ШБ 1.2.6-1.2.18") is handed to the localizer so
    # the LLM writes it into the user's-language line.
    assert any("ШБ 1.2.6-1.2.18" in s for s in llm.situations)


async def test_bare_ref_with_no_lectures_asks_to_show_verses(_events) -> None:
    # When the ref-index is ALSO empty, don't dead-end: ask whether the user
    # wanted the verses themselves, with a self-contained chip.
    llm = _FakeLLM()
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[]]),
        catalog_repo=_Catalog(ref_tracks=[]),  # semantic AND ref-index empty
        llm=llm,
        lang="ru",
    )
    await ftw.find_tracks_worker_node(
        {
            "user_query": "sb 1.2.6-1.2.18",
            "extracted_args": {"source_id": "SB", "tokens": "1.2.6-1.2.18"},
        },
        _Runtime(ctx),
    )
    text = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert not [e for e in _events if e["type"] == "action"]  # no cards — a question
    assert "LINE[localized_reply]" in text
    assert "[followup:CHIP]" in text
    # The "no lectures on <ref>, show verses?" ask is localized with the ref.
    assert any("ШБ 1.2.6-1.2.18" in s for s in llm.situations)


async def test_topic_plus_date_applies_date_filter(_events) -> None:
    # "лекции про карму за 1975" — a topic AND an explicit date range. The
    # semantic path must constrain the search by date (regression: _build_filters
    # used to read only `year` and dropped date_from/date_to/anniversary_md).
    chunks = [_sc("t1", 70000, 0.9, "quote")]
    cat = _Catalog(titles={"t1": "Лекция"}, descriptions={"t1": "d"})
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks]),
        catalog_repo=cat,
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node(
        {
            "user_query": "карма",
            "extracted_args": {"date_from": "1975-01-01", "date_to": "1975-12-31",
                               "anniversary_md": "07-09"},
        },
        _Runtime(ctx),
    )
    # The date constraint reached the catalog filter, not silently dropped.
    assert cat.filter_kwargs.get("date_from") == "1975-01-01"
    assert cat.filter_kwargs.get("date_to") == "1975-12-31"
    assert cat.filter_kwargs.get("anniversary_md") == "07-09"


async def test_date_only_query_probes_and_serves(_events) -> None:
    # "лекции 9 июля" → anniversary_md; semantic search finds nothing (no topic
    # to embed), so probe the catalog's date index and serve what's on that day.
    refs = [_track("d1", "Все измы"), _track("d2", "Смерть — это Бог")]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[]]),
        catalog_repo=_Catalog(ref_tracks=refs),  # list_tracks returns these
        llm=_FakeLLM(),
        lang="ru",
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции 9 июля", "extracted_args": {"anniversary_md": "07-09"}},
        _Runtime(ctx),
    )
    card_ids = [
        e["data"]["payload"]["track_id"]
        for e in _events if e["type"] == "action" and e["data"]["kind"] == "card"
    ]
    assert card_ids == ["d1", "d2"]
    text = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert "LINE[localized_reply]" in text  # LLM-localized lead-in, any language


async def test_date_query_with_no_lectures_says_so(_events) -> None:
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[]]),
        catalog_repo=_Catalog(ref_tracks=[]),
        llm=_FakeLLM(),
        lang="ru",
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции 30 февраля", "extracted_args": {"anniversary_md": "02-30"}},
        _Runtime(ctx),
    )
    text = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert not [e for e in _events if e["type"] == "action"]
    assert "LINE[localized_reply]" in text  # localized "no lectures for that date"


async def test_empty_topic_query_still_flat_empty(_events) -> None:
    # A topical query (no scripture ref) with no results keeps the old flat
    # empty line — clarify is only for bare references.
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[]]),
        catalog_repo=_Catalog(),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "очищение сердца", "extracted_args": {}}, _Runtime(ctx)
    )
    text = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert "[followup:" not in text


async def test_uncatalogued_track_dropped(_events) -> None:
    # t1 is in the catalog, t2 is NOT (no title) → only t1 surfaces.
    chunks = [_sc("t1", 70000, 0.9, "q1"), _sc("t2", 70000, 0.8, "q2")]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks]),
        catalog_repo=_Catalog(titles={"t1": "Лекция А"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node({"user_query": "x", "extracted_args": {}}, _Runtime(ctx))
    card_ids = [
        e["data"]["payload"]["track_id"]
        for e in _events if e["type"] == "action" and e["data"]["kind"] == "card"
    ]
    assert card_ids == ["t1"]


async def test_prefers_non_intro_chunk_for_quote(_events) -> None:
    # Higher-scoring intro chunk (start<60s) vs lower non-intro one → quote the
    # non-intro passage; relevance still uses the track's best score.
    chunks = [_sc("t1", 5000, 0.95, "intro boilerplate"), _sc("t1", 90000, 0.7, "real passage")]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks]),
        catalog_repo=_Catalog(titles={"t1": "Лекция"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node({"user_query": "x", "extracted_args": {}}, _Runtime(ctx))
    cite = next(e for e in _events if e["type"] == "action" and e["data"]["kind"] == "cite_transcript")
    assert cite["data"]["payload"]["text"] == "real passage"


async def test_author_absent_from_corpus_says_so_and_offers_the_web(_events) -> None:
    # The catalog fake resolves NO author (resolve() returns [] for author), so
    # a teacher the corpus lacks must NOT be answered with some OTHER teacher's
    # semantic hits. Say we don't have them + offer the web (a chip that routes
    # into add-to-library).
    chunks = [_sc("t1", 70000, 0.9, "t1 best quote")]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks]),
        catalog_repo=_Catalog(titles={"t1": "Лекция А"}, descriptions={"t1": "d"}),
        llm=_FakeLLM(),
    )
    out = await ftw.find_tracks_worker_node(
        {
            "user_query": "find lectures of some teacher",
            "extracted_args": {"author": "Some Teacher"},
        },
        _Runtime(ctx),
    )
    assert out == {}
    # NO lecture cards — we did not hand back a different teacher's lectures.
    actions = [e for e in _events if e["type"] == "action"]
    assert [a for a in actions if a["data"]["kind"] in ("card", "cite_transcript")] == []
    # An honest localized line + a tappable follow-up chip (→ add-to-library).
    full = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert "LINE[localized_reply]" in full
    assert "[followup:CHIP]" in full


async def test_author_weak_common_word_match_treated_as_absent(_events) -> None:
    # "niranjana swami" grazes "…Swami Prabhupada" at 0.5 — below the floor, so
    # it must NOT hand back Prabhupada's lectures; say we don't have them.
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.9, "q")]]),
        catalog_repo=_Catalog(
            titles={"t1": "Лекция"}, descriptions={"t1": "d"},
            authors={"Niranjana Swami": ("prabhupada", 0.5)},
        ),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "find lectures of niranjana swami",
         "extracted_args": {"author": "Niranjana Swami"}},
        _Runtime(ctx),
    )
    actions = [e for e in _events if e["type"] == "action"]
    assert [a for a in actions if a["data"]["kind"] in ("card", "cite_transcript")] == []
    full = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert "[followup:CHIP]" in full


async def test_author_strong_match_proceeds_to_search(_events) -> None:
    # A real corpus author (confidence 1.0) is above the floor → we search and
    # surface cards, we do NOT emit the "not in the app" reply.
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.9, "best quote")]]),
        catalog_repo=_Catalog(
            titles={"t1": "Лекция"}, descriptions={"t1": "d"},
            authors={"Prabhupada": ("prabhupada", 1.0)},
        ),
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "lectures by prabhupada",
         "extracted_args": {"author": "Prabhupada"}},
        _Runtime(ctx),
    )
    actions = [e for e in _events if e["type"] == "action"]
    assert [a for a in actions if a["data"]["kind"] == "card"]  # cards emitted
