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
from rapidfuzz import fuzz, utils

from lectorium_chat.agent.graph.nodes import find_tracks_worker as ftw
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain.entities import Chunk, ResolvedEntity, ScoredChunk, Track

# The catalog's real author dictionary as `authors` rows: (id, language,
# full_name). Tests that exercise the author guard use these rather than invented
# names, because the guard's whole difficulty is that real honorifics collide
# across teachers — and that ONE teacher has a different spelling per locale.
#
# The per-locale split matters: production must resolve with lang=None, and a
# fake that pooled every locale regardless would pass either way, hiding the
# regression where a ru user's request was matched against Cyrillic names only.
CORPUS_AUTHORS = (
    ("author_prabhupada", "en", "A. C. Bhaktivedanta Swami Prabhupada"),
    ("author_bhaktisiddhanta", "en", "Śrīla Bhaktisiddhānta Sarasvatī Ṭhākura"),
    ("author_bhaktivinoda", "en", "Śrīla Bhaktivinoda Ṭhākura"),
    ("author_prabhupada", "ru", "А. Ч. Бхактиведанта Свами Прабхупада"),
    ("author_bhaktisiddhanta", "ru", "Шрила Бхактисиддханта Сарасвати Тхакур"),
    ("author_bhaktivinoda", "ru", "Шрила Бхактивинода Тхакур"),
)


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
    capabilities: dict = field(default_factory=lambda: {"personal_library": True})


@dataclass
class _Runtime:
    context: _Ctx


class _Embedder:
    async def embed_query(self, text: str) -> list[float]:
        return [0.1, 0.2, 0.3]


class _ChunkRepo:
    def __init__(
        self, results: list[list[ScoredChunk]], *, transcript_langs: set[str] | None = None,
    ) -> None:
        self._results = results
        # Which transcript languages exist. When set, a search constrained to a
        # language outside it finds NOTHING — mirroring the real predicate, so a
        # test can pin the "only exists in English" case. None = any lang hits.
        self._transcript_langs = transcript_langs
        self.calls = 0
        self.langs_searched: list[str | None] = []

    async def search_by_embedding(self, embedding, *, eligible_track_ids, lang, top_k):
        self.langs_searched.append(lang)
        if (
            self._transcript_langs is not None
            and lang is not None
            and lang not in self._transcript_langs
        ):
            self.calls += 1
            return []
        i = min(self.calls, len(self._results) - 1)
        self.calls += 1
        return self._results[i]


def _track(tid: str, title: str | None, lang: str = "ru") -> Track:
    return Track(
        id=tid, title=title, lang=lang, date="1976-01-01",
        author_id="a1", author_name="Prabhupada", location_id=None, location_name=None,
        tag_ids=(), tag_names=(), duration_ms=None, references=(),
    )


class _Catalog:
    def __init__(
        self, *, titles=None, descriptions=None, eligible=None, sources=None,
        ref_tracks=None, authors=None,
    ) -> None:
        # authors: the catalog's author full names (see CORPUS_AUTHORS). Resolved
        # with the same fuzzy scorer as production so the tests see the real
        # scores, not hand-picked ones.
        self._authors = tuple(authors or ())
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
        self.list_tracks_langs: list[str | None] = []

    async def filter_track_ids(self, **kwargs):
        self.filter_kwargs = kwargs
        return self._eligible

    async def list_tracks(self, **kwargs):
        # The ref-index probe: return the configured lectures regardless of the
        # exact ref window (the parsing is covered by _ref_filter's own tests).
        # `lang` IS honoured, because it means "has a transcript in this
        # language" — a lecture that exists only in English must be invisible to
        # a lang="ru" probe and visible to a lang=None one.
        lang = kwargs.get("lang")
        self.list_tracks_langs.append(lang)
        if lang is None:
            return list(self._ref_tracks)
        return [t for t in self._ref_tracks if t.lang == lang]

    async def language_name(self, code):
        return {"ru": "Русский", "en": "English", "hi": "हिन्दी"}.get(code)

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
        if kind == "author":
            # Mirror the real resolver: `lang` NARROWS the dictionary to that
            # locale's rows (lang=None pools every locale), then rank the
            # surviving names with the same fuzzy scorer.
            pool = [
                (aid, name) for aid, language, name in self._authors
                if lang is None or language == lang
            ]
            scored = sorted(
                (
                    (
                        fuzz.token_set_ratio(
                            text, name, processor=utils.default_process,
                        ) / 100.0,
                        aid,
                        name,
                    )
                    for aid, name in pool
                ),
                key=lambda p: -p[0],
            )
            return [
                ResolvedEntity(id=aid, full_name=name, confidence=conf, extra={})
                # 0.4 mirrors _fuzzy_top's score_cutoff — below it the real
                # resolver returns nothing at all.
                for conf, aid, name in scored[:limit] if conf >= 0.4
            ]
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
        # (run_name, user prompt) per call, so a test can assert WHAT a hop was
        # told — the lead-in's honesty about a dropped filter and about a
        # language it had to fall back to both live there.
        self.prompts: list[tuple[str, str]] = []

    def prompt_for(self, run_name: str) -> str:
        return next((p for r, p in self.prompts if r == run_name), "")

    async def structured_output(self, messages, schema, *, run_name=None, model=None, callbacks=None):
        # Only the localized clarify/empty reply (LocalizedReply — line+chips)
        # still uses structured_output; the per-card blurb + intro are plain
        # text now (see `text_completion`).
        self.calls.append(run_name or "")
        situation = messages[-1]["content"]
        self.prompts.append((run_name or "", situation))
        self.situations.append(situation)
        # A deterministic stand-in: a marker line + one chip, so tests can
        # assert the localized path ran and a chip was emitted, without
        # depending on real LLM phrasing.
        return schema(line=f"LINE[{run_name}]", chips=["CHIP"])

    async def text_completion(self, messages, *, model=None, run_name=None):
        self.calls.append(run_name or "")
        self.prompts.append((run_name or "", messages[-1]["content"]))
        return f"prose[{run_name}]"

    def prompt_for(self, run_name: str) -> str:
        return next(p for name, p in self.prompts if name == run_name)


def _sc(
    track_id: str, start: int, score: float, text: str, lang: str = "ru",
) -> ScoredChunk:
    return ScoredChunk(
        chunk=Chunk(
            track_id=track_id, lang=lang, start_ms=start, end_ms=start + 1000,
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


async def test_empty_topic_query_routes_to_web_fallback(_events) -> None:
    # A topical query with no corpus match sets `web_fallback` (graph then routes
    # to add_to_library_worker); find_tracks itself streams no line or card.
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[]]),
        catalog_repo=_Catalog(),
        llm=_FakeLLM(),
    )
    result = await ftw.find_tracks_worker_node(
        {"user_query": "очищение сердца", "extracted_args": {}}, _Runtime(ctx)
    )
    assert result.get("web_fallback") is True
    assert not [e for e in _events if e["type"] == "action"]
    text = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert "[followup:" not in text


async def test_no_corpus_match_without_capability_skips_web_fallback(_events) -> None:
    # A build that can't add lectures from the web never gets routed there: the
    # same empty-corpus query yields a plain not-found, no `web_fallback`.
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[]]),
        catalog_repo=_Catalog(),
        llm=_FakeLLM(),
        capabilities={},
    )
    result = await ftw.find_tracks_worker_node(
        {"user_query": "очищение сердца", "extracted_args": {}}, _Runtime(ctx)
    )
    assert result.get("web_fallback") is not True


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


async def test_ref_probe_serves_lectures_that_exist_only_in_another_language(
    _events,
) -> None:
    # The prod failure: a ru user asked for ШБ 2.9.1 (Токио, 23.04.1972). The
    # corpus HAS that lecture — in English only — so the lang="ru" probe found
    # nothing and the user was told the app has no Prabhupāda lectures at all.
    # Now the en-only lecture is SERVED, and the lead-in must name BOTH
    # languages: nothing in Russian, but found in English.
    refs = [_track("r1", "The Stages of Creation", lang="en")]
    llm = _FakeLLM()
    catalog = _Catalog(ref_tracks=refs)
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[]]),  # semantic: zero
        catalog_repo=catalog,
        llm=llm,
        lang="ru",
    )
    out = await ftw.find_tracks_worker_node(
        {
            "user_query": "Шрила Прабхупада — ШБ 2.9.1 Токио 23.04.1972 найди лекцию",
            "extracted_args": {"source_id": "SB", "tokens": "2.9.1"},
        },
        _Runtime(ctx),
    )
    assert out == {}
    card_ids = [
        e["data"]["payload"]["track_id"]
        for e in _events if e["type"] == "action" and e["data"]["kind"] == "card"
    ]
    assert card_ids == ["r1"]  # served, not hidden
    # It asked in the user's language FIRST, and only then language-agnostically.
    assert catalog.list_tracks_langs == ["ru", None]
    # The localizer was told to name both languages by their real names.
    situation = next(s for s in llm.situations if "Русский" in s)
    assert "English" in situation
    assert "NO transcript in the user's own language" in situation


async def test_semantic_search_falls_back_across_languages(_events) -> None:
    # Same rule on the semantic path: when no transcript in the user's language
    # matches, retry language-agnostically rather than dead-ending, and tell the
    # intro writer which language the results are actually in.
    llm = _FakeLLM()
    chunks = [_sc("t1", 70000, 0.9, "an english passage", lang="en")]
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([chunks], transcript_langs={"en"}),
        catalog_repo=_Catalog(titles={"t1": "A lecture"}, descriptions={"t1": "d"}),
        llm=llm,
        lang="ru",
    )
    out = await ftw.find_tracks_worker_node(
        {"user_query": "лекции про преданное служение", "extracted_args": {}},
        _Runtime(ctx),
    )
    assert out == {}
    assert [a for a in _events
            if a["type"] == "action" and a["data"]["kind"] == "card"]  # served
    intro_prompt = llm.prompt_for("find_tracks_intro")
    assert "Русский" in intro_prompt and "English" in intro_prompt


async def test_same_language_results_carry_no_language_note(_events) -> None:
    # The note is for the exceptional case only: when the user's own language
    # HAS the lecture, nothing about languages should be said.
    llm = _FakeLLM()
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.9, "отрывок", lang="ru")]],
                              transcript_langs={"ru", "en"}),
        catalog_repo=_Catalog(titles={"t1": "Лекция"}, descriptions={"t1": "d"}),
        llm=llm,
        lang="ru",
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции про преданное служение", "extracted_args": {}},
        _Runtime(ctx),
    )
    intro_prompt = llm.prompt_for("find_tracks_intro")
    assert "English" not in intro_prompt
    assert "NO transcript" not in intro_prompt


async def test_author_absent_from_corpus_routes_to_web(_events) -> None:
    # The catalog fake resolves NO author, so a teacher the corpus lacks must NOT
    # be answered with some OTHER teacher's semantic hits — it sets web_fallback
    # (graph → add_to_library_worker) and streams no line/card of its own.
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
    assert out == {"web_fallback": True}
    actions = [e for e in _events if e["type"] == "action"]
    assert [a for a in actions if a["data"]["kind"] in ("card", "cite_transcript")] == []
    full = "".join(e["data"]["text"] for e in _events if e["type"] == "delta")
    assert "[followup:" not in full


@pytest.mark.parametrize(
    "author",
    [
        "Niranjana Swami",        # shares only the honorific with our author
        "Ниранджана Свами",       # …and in the user's own script
        "Bhakti Caitanya Swami",  # scores 0.62 — the closest stranger
        "Krishna Ksetra Swami",
        "Bir Krishna Goswami",
        "Suresh Kumar",
    ],
)
async def test_author_absent_when_only_honorifics_are_shared(_events, author) -> None:
    # A teacher the corpus lacks must NOT be answered with Prabhupada's lectures,
    # however close the fuzzy score gets: route to web discovery instead.
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.9, "q")]]),
        catalog_repo=_Catalog(
            titles={"t1": "Лекция"}, descriptions={"t1": "d"},
            authors=CORPUS_AUTHORS,
        ),
        llm=_FakeLLM(),
    )
    out = await ftw.find_tracks_worker_node(
        {"user_query": f"find lectures of {author}",
         "extracted_args": {"author": author}},
        _Runtime(ctx),
    )
    assert out == {"web_fallback": True}
    actions = [e for e in _events if e["type"] == "action"]
    assert [a for a in actions if a["data"]["kind"] in ("card", "cite_transcript")] == []


@pytest.mark.parametrize(
    "author",
    [
        # The prod regression: a ru user wrote "Шрила Прабхупада", the router
        # normalized it to English, and matching that against the CYRILLIC
        # dictionary scored 0.05 — so the app's own and only author read as
        # absent and the user was told "лекций Шрилы Прабхупады нет".
        "Srila Prabhupada",
        "Прабхупада",
        "Шрила Прабхупада",
        "Prabhupada",
        "A. C. Bhaktivedanta Swami Prabhupada",
        "His Divine Grace A. C. Bhaktivedanta Swami Prabhupada",
        "Bhaktivinoda Thakura",
    ],
)
async def test_corpus_author_is_found_across_scripts_and_honorifics(
    _events, author,
) -> None:
    # A name that denotes a corpus author — in either script, with or without
    # honorifics — must reach the search and surface cards, never the
    # "not in the app" route.
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.9, "best quote")]]),
        catalog_repo=_Catalog(
            titles={"t1": "Лекция"}, descriptions={"t1": "d"},
            authors=CORPUS_AUTHORS,
        ),
        llm=_FakeLLM(),
    )
    out = await ftw.find_tracks_worker_node(
        {"user_query": f"lectures by {author}",
         "extracted_args": {"author": author}},
        _Runtime(ctx),
    )
    assert out == {}
    actions = [e for e in _events if e["type"] == "action"]
    assert [a for a in actions if a["data"]["kind"] == "card"]  # cards emitted


async def test_resolved_author_id_constrains_the_search(_events) -> None:
    # The guard and the FILTER must agree: the author the guard accepted is the
    # author the catalog filter constrains on. Previously they were two separate
    # resolves and could disagree.
    catalog = _Catalog(
        titles={"t1": "Лекция"}, descriptions={"t1": "d"},
        authors=CORPUS_AUTHORS, eligible=["t1"],
    )
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.9, "q")]]),
        catalog_repo=catalog,
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "lectures by Srila Prabhupada",
         "extracted_args": {"author": "Srila Prabhupada"}},
        _Runtime(ctx),
    )
    assert catalog.filter_kwargs["author_id"] == "author_prabhupada"


async def test_honorific_only_author_does_not_constrain_or_bail(_events) -> None:
    # "Свами" names no particular teacher: no web fallback (we don't claim the
    # corpus lacks them) and no author filter (we don't guess who they meant).
    catalog = _Catalog(
        titles={"t1": "Лекция"}, descriptions={"t1": "d"},
        authors=CORPUS_AUTHORS, eligible=["t1"],
    )
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_ChunkRepo([[_sc("t1", 70000, 0.9, "q")]]),
        catalog_repo=catalog,
        llm=_FakeLLM(),
    )
    out = await ftw.find_tracks_worker_node(
        {"user_query": "лекции свами", "extracted_args": {"author": "Свами"}},
        _Runtime(ctx),
    )
    assert out == {}
    assert catalog.filter_kwargs.get("author_id") is None


# ── a named chapter must constrain the search, not just the header ─────────
#
# Production, 31.07: «Какие здесь есть лекции по БГ 10» → lectures on chapter 9
# under «Вот лекции по Бхагавад-гите 10:». The user noticed («Ты мне раньше дал
# 9 главу вместо 12») and re-asking returned the same wrong track. The header was
# written from the query while the tracks came from an unconstrained ANN search.


class _RefCatalog(_Catalog):
    """Catalog whose `filter_track_ids` actually honours the reference.

    Chapter matching here is a deliberate one-liner of its own — NOT production's
    `_ref_filter` — so a test cannot pass by mirroring the code it checks. The
    real predicate has its own tests over a real SQLite catalog in
    `tests/infra/test_catalog_ref_filter.py`.
    """

    def __init__(self, *, chapters: dict[str, int], **kw) -> None:
        super().__init__(**kw)
        self._chapters = chapters

    async def filter_track_ids(self, **kwargs):
        self.filter_kwargs = kwargs
        ref_from = kwargs.get("ref_from")
        if ref_from is None:
            return self._eligible
        return [tid for tid, ch in self._chapters.items() if ch == ref_from]


class _EligibleAwareChunkRepo:
    """Returns only chunks whose track survived the catalog filter — the step
    that was missing end to end."""

    def __init__(self, chunks: list[ScoredChunk]) -> None:
        self._chunks = chunks
        self.eligible_seen: list[Any] = []

    async def search_by_embedding(self, embedding, *, eligible_track_ids, lang, top_k):
        self.eligible_seen.append(eligible_track_ids)
        if eligible_track_ids is None:
            return list(self._chunks)
        allowed = set(eligible_track_ids)
        return [c for c in self._chunks if c.chunk.track_id in allowed]


def _ref_ctx(chunks, *, chapters, titles, llm=None):
    cat = _RefCatalog(
        chapters=chapters, titles=titles,
        descriptions={t: "d" for t in titles},
        sources={"source_BG": "БГ"},
    )
    return _Ctx(
        embedder=_Embedder(),
        chunk_repo=_EligibleAwareChunkRepo(chunks),
        catalog_repo=cat,
        llm=llm or _FakeLLM(),
    ), cat


async def test_a_named_chapter_keeps_other_chapters_out(_events) -> None:
    # The chapter-9 lecture is what production actually served for this ask.
    chunks = [_sc("bg_9_11", 70000, 0.9, "q9"), _sc("bg_10_1", 70000, 0.8, "q10")]
    ctx, _cat = _ref_ctx(
        chunks,
        chapters={"bg_9_11": 9, "bg_10_1": 10},
        titles={"bg_9_11": "БГ 9.11", "bg_10_1": "БГ 10.1"},
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "Какие здесь есть лекции по БГ 10",
         "extracted_args": {"source_id": "BG", "tokens": "10"}},
        _Runtime(ctx),
    )
    text = "".join(
        e["data"].get("text", "") for e in _events if e.get("type") == "delta"
    )
    assert "[card:bg_10_1]" in text
    assert "[card:bg_9_11]" not in text


async def test_the_chapter_reaches_the_catalog_filter(_events) -> None:
    chunks = [_sc("bg_10_1", 70000, 0.9, "q")]
    ctx, cat = _ref_ctx(
        chunks, chapters={"bg_10_1": 10}, titles={"bg_10_1": "БГ 10.1"},
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции по БГ 10",
         "extracted_args": {"source_id": "BG", "tokens": "10"}},
        _Runtime(ctx),
    )
    assert cat.filter_kwargs.get("ref_from") == 10
    assert cat.filter_kwargs.get("ref_to") == 10
    assert cat.filter_kwargs.get("ref_prefix") is None  # bare chapter


async def test_a_verse_address_narrows_to_its_chapter_and_verse(_events) -> None:
    chunks = [_sc("bg_2_13", 70000, 0.9, "q")]
    ctx, cat = _ref_ctx(
        chunks, chapters={"bg_2_13": 13}, titles={"bg_2_13": "БГ 2.13"},
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции по БГ 2.13",
         "extracted_args": {"source_id": "BG", "tokens": "2.13"}},
        _Runtime(ctx),
    )
    assert cat.filter_kwargs.get("ref_prefix") == "2"
    assert cat.filter_kwargs.get("ref_from") == 13


async def test_a_chapter_without_a_book_is_not_a_reference_filter(_events) -> None:
    # A bare "10" doesn't say which book, so it must not silently filter.
    chunks = [_sc("t1", 70000, 0.9, "q")]
    ctx, cat = _ref_ctx(chunks, chapters={"t1": 10}, titles={"t1": "Лекция"})
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции по 10 главе", "extracted_args": {"tokens": "10"}},
        _Runtime(ctx),
    )
    assert cat.filter_kwargs.get("ref_from") is None


async def test_a_lead_in_may_not_claim_a_chapter_that_was_dropped(_events) -> None:
    # Nothing on chapter 12, so the ladder relaxes to the book. The lectures are
    # still shown — but the line is forbidden to present them as chapter 12.
    chunks = [_sc("bg_9_11", 70000, 0.9, "q")]
    llm = _FakeLLM()
    ctx, _cat = _ref_ctx(
        chunks, chapters={"bg_9_11": 9}, titles={"bg_9_11": "БГ 9.11"}, llm=llm,
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "Лекции по БГ глава 12",
         "extracted_args": {"source_id": "BG", "tokens": "12"}},
        _Runtime(ctx),
    )
    intro = llm.prompt_for("find_tracks_intro")
    assert "reference" in intro                       # which filter was dropped
    assert "БГ 12" in intro                           # the human address
    assert "are NOT on" in intro                      # and the explicit ban


async def test_a_matched_chapter_leaves_the_lead_in_alone(_events) -> None:
    chunks = [_sc("bg_10_1", 70000, 0.9, "q")]
    llm = _FakeLLM()
    ctx, _cat = _ref_ctx(
        chunks, chapters={"bg_10_1": 10}, titles={"bg_10_1": "БГ 10.1"}, llm=llm,
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции по БГ 10",
         "extracted_args": {"source_id": "BG", "tokens": "10"}},
        _Runtime(ctx),
    )
    intro = llm.prompt_for("find_tracks_intro")
    assert "are NOT on" not in intro
    assert "Relaxed filters: none" in intro


# ── the lecturer outranks the language ─────────────────────────────────────
#
# The relaxation ladder can drop the author, and it can cross the language
# boundary. Which of the two goes first decides what the user is told when the
# teacher they named has nothing in their language:
#
#   author dropped first → «вот лекции про X» … by somebody else, silently
#   language first       → «лекций X на русском нет, есть на английском»
#
# The second is what a person asking for a named teacher wants: they asked for
# THAT teacher. Only reachable with more than one lecturer in the corpus, which
# is why fakes carry two here.


class _TwoAuthorCatalog(_Catalog):
    """Catalog where the requested teacher exists but has no Russian lecture.

    `filter_track_ids` narrows to the author when asked; `_ChunkRepo` then
    narrows to the language. Between them they reproduce the only situation
    where the ladder order is observable.
    """

    TRACKS = {
        # track_id: (author_id, transcript language)
        "ours_en": ("author_ours", "en"),
        "other_ru": ("author_other", "ru"),
    }

    AUTHORS = (
        ("author_ours", "en", "A. C. Bhaktivedanta Swami Prabhupada"),
        ("author_ours", "ru", "А. Ч. Бхактиведанта Свами Прабхупада"),
        ("author_other", "en", "Śrīla Bhaktivinoda Ṭhākura"),
        ("author_other", "ru", "Шрила Бхактивинода Тхакур"),
    )

    def __init__(self) -> None:
        super().__init__(
            titles={"ours_en": "Our teacher, in English",
                    "other_ru": "Another teacher, in Russian"},
            descriptions={"ours_en": "d", "other_ru": "d"},
            authors=self.AUTHORS,
        )

    async def filter_track_ids(self, **kwargs):
        self.filter_kwargs = kwargs
        author = kwargs.get("author_id")
        if author is None:
            return list(self.TRACKS)
        return [t for t, (a, _l) in self.TRACKS.items() if a == author]


class _LangAwareChunkRepo:
    """Returns a track's chunk only when its transcript language is asked for
    (or the caller asked for any language)."""

    def __init__(self, tracks: dict[str, tuple[str, str]]) -> None:
        self._tracks = tracks
        self.langs_searched: list[str | None] = []

    async def search_by_embedding(self, embedding, *, eligible_track_ids, lang, top_k):
        self.langs_searched.append(lang)
        allowed = None if eligible_track_ids is None else set(eligible_track_ids)
        out = []
        for tid, (_author, tlang) in self._tracks.items():
            if allowed is not None and tid not in allowed:
                continue
            if lang is not None and lang != tlang:
                continue
            out.append(_sc(tid, 70000, 0.9, "quote", lang=tlang))
        return out


async def test_the_named_teacher_survives_the_language_switch(_events) -> None:
    """«лекции Шрилы Прабхупады про X»: nothing of theirs in Russian, plenty by
    ANOTHER teacher. The answer must be their English lecture, not somebody
    else's Russian one."""
    catalog = _TwoAuthorCatalog()
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_LangAwareChunkRepo(_TwoAuthorCatalog.TRACKS),
        catalog_repo=catalog,
        llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции Шрилы Прабхупады про карму",
         "extracted_args": {"author": "Srila Prabhupada"}},
        _Runtime(ctx),
    )
    text = "".join(
        e["data"].get("text", "") for e in _events if e.get("type") == "delta"
    )
    assert "[card:ours_en]" in text, "the teacher the user named must be served"
    assert "[card:other_ru]" not in text, "another teacher's lecture is not an answer"


async def test_and_the_lead_in_says_which_language_they_are_in(_events) -> None:
    catalog = _TwoAuthorCatalog()
    llm = _FakeLLM()
    ctx = _Ctx(
        embedder=_Embedder(),
        chunk_repo=_LangAwareChunkRepo(_TwoAuthorCatalog.TRACKS),
        catalog_repo=catalog,
        llm=llm,
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции Шрилы Прабхупады про карму",
         "extracted_args": {"author": "Srila Prabhupada"}},
        _Runtime(ctx),
    )
    intro = llm.prompt_for("find_tracks_intro")
    # The honest version of this answer names the language it had to cross into.
    assert "English" in intro or "Английский" in intro
    # And it must NOT report the author as given up — the author was kept.
    assert "author" not in intro.split("Relaxed filters:")[1].split("\n")[0]


async def test_a_query_with_no_author_is_unaffected(_events) -> None:
    # Without an author there is no rung to protect: the ladder behaves as before.
    catalog = _TwoAuthorCatalog()
    repo = _LangAwareChunkRepo(_TwoAuthorCatalog.TRACKS)
    ctx = _Ctx(
        embedder=_Embedder(), chunk_repo=repo, catalog_repo=catalog, llm=_FakeLLM(),
    )
    await ftw.find_tracks_worker_node(
        {"user_query": "лекции про карму", "extracted_args": {}},
        _Runtime(ctx),
    )
    text = "".join(
        e["data"].get("text", "") for e in _events if e.get("type") == "delta"
    )
    # The Russian lecture is a perfectly good answer here.
    assert "[card:other_ru]" in text
