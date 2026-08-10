"""Unit tests for the locate pipeline (research/locate.py) + fetch_titles.

Covers the seams the plan review flagged: numeric token sort, book-aware
chapter grouping, granularity decision, and title whitespace normalization.
Uses fake embedder/chunk_repo + a temp library.db so no Postgres/embeddings
are needed.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from lectorium_chat.domain.entities import LibraryChunk, ScoredLibraryChunk
from lectorium_chat.infra.repositories.sqlite_library_repository import (
    SqliteLibraryRepository,
)
from lectorium_chat.research import locate


SB = "source_SB"


def _make_library_repo(tmp_path: Path) -> SqliteLibraryRepository:
    db = tmp_path / "library.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE library_titles (source_id TEXT, tokens TEXT, language TEXT, title TEXT)"
    )
    rows = [
        (SB, "12", "ru", "Песнь 12 «Век деградации»"),
        # embedded CR/LF — must be normalized to a single space.
        (SB, "12.8", "ru", "Молитвы\r\nМаркандейи Нара-Нараяне Риши"),
        (SB, "12.9", "ru", "Маркандея Риши\r\nсозерцает иллюзорную энергию Господа"),
        (SB, "12.10", "ru", "Господь Шива и Ума прославляют Маркандею Риши"),
        # en-only chapter to exercise the lang fallback chain.
        (SB, "12.11", "en", "A Description of the Mahapurusa"),
    ]
    conn.executemany(
        "INSERT INTO library_titles (source_id, tokens, language, title) VALUES (?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()
    return SqliteLibraryRepository(db)


@pytest.mark.asyncio
async def test_fetch_titles_normalizes_whitespace_and_lang_fallback(tmp_path):
    lib = _make_library_repo(tmp_path)
    titles = await lib.fetch_titles(SB, lang="ru")
    assert titles["12"] == "Песнь 12 «Век деградации»"
    # \r\n collapsed to single space.
    assert titles["12.8"] == "Молитвы Маркандейи Нара-Нараяне Риши"
    assert "\n" not in titles["12.9"] and "\r" not in titles["12.9"]
    # ru missing for 12.11 → falls back to en.
    assert titles["12.11"] == "A Description of the Mahapurusa"


def test_numeric_key_orders_chapters_correctly():
    toks = ["12.10", "12.2", "12.8", "12.1"]
    assert sorted(toks, key=locate._numeric_key) == ["12.1", "12.2", "12.8", "12.10"]


def test_chapter_range_collapses_runs():
    from lectorium_chat.agent.graph.nodes.locate_worker import _chapter_range

    assert _chapter_range(["12.8", "12.9", "12.10"]) == "8–10"
    assert _chapter_range(["7.1", "7.2", "7.5", "7.6"]) == "1–2, 5–6"
    assert _chapter_range(["2"]) == "2"


class _FakeEmbedder:
    async def embed_query(self, q):
        return [0.1] * 8


class _FakeChunkRepo:
    def __init__(self, scored):
        self._scored = scored
        self.last_source_id = "UNSET"

    async def search_library_by_embedding(self, embedding, *, kinds, source_id=None,
                                          lang=None, top_k=8, **kw):
        self.last_source_id = source_id
        return self._scored


def _scored(item_kind, source_id, tokens, addr_label, score):
    return ScoredLibraryChunk(
        chunk=LibraryChunk(
            item_id=f"{item_kind}_{tokens}", item_kind=item_kind, source_id=source_id,
            tokens=tokens, author_id=None, doc_date=None, lang="ru",
            segment_index=0, text="…", addr_label=addr_label,
        ),
        score=score,
    )


@pytest.mark.asyncio
async def test_run_locate_groups_chapters_into_region(tmp_path):
    lib = _make_library_repo(tmp_path)
    repo = _FakeChunkRepo([
        _scored("verse", SB, "12.8.10", "ШБ 12.8.10", 0.71),
        _scored("verse", SB, "12.9.1", "ШБ 12.9.1", 0.66),
        _scored("title", SB, "12.10", "ШБ 12.10", 0.63),
        _scored("verse", SB, "12.2.3", "ШБ 12.2.3", 0.40),  # below floor → dropped
    ])
    result = await locate.run_locate(
        question="в какой песни Шримад-Бхагаватам история Маркандеи",
        lang="ru", router_args={},
        chunk_repo=repo, embedder=_FakeEmbedder(),
        pool=None, library_repo=lib,
    )
    assert result.verses == []
    assert len(result.regions) == 1
    region = result.regions[0]
    assert region.source_id == SB
    assert region.region_token == "12"
    assert region.region_label == "Песнь 12 «Век деградации»"
    # 12.2 dropped (below floor); 12.8/12.9/12.10 present, numerically ordered.
    assert [c.tokens for c in region.chapters] == ["12.8", "12.9", "12.10"]
    assert region.chapters[0].title == "Молитвы Маркандейи Нара-Нараяне Риши"


@pytest.mark.asyncio
async def test_run_locate_verse_cue_returns_verses(tmp_path):
    lib = _make_library_repo(tmp_path)
    repo = _FakeChunkRepo([
        _scored("verse", SB, "12.8.10", "ШБ 12.8.10", 0.72),
    ])
    result = await locate.run_locate(
        question="в каком стихе сказано про победу над смертью",
        lang="ru", router_args={},
        chunk_repo=repo, embedder=_FakeEmbedder(),
        pool=None, library_repo=lib,
    )
    assert result.regions == []
    assert len(result.verses) == 1
    assert result.verses[0].tokens == "12.8.10"


@pytest.mark.asyncio
async def test_run_locate_drops_short_source_code(tmp_path):
    # Regression: the router emits a SHORT code ("SB"); it must NOT be passed
    # as the opaque ANN source filter (would match nothing). Bug B.
    lib = _make_library_repo(tmp_path)
    repo = _FakeChunkRepo([_scored("verse", SB, "12.8.10", "ШБ 12.8.10", 0.7)])
    await locate.run_locate(
        question="в какой песни ШБ история Маркандеи", lang="ru",
        router_args={"source_id": "SB"},
        chunk_repo=repo, embedder=_FakeEmbedder(), pool=None, library_repo=lib,
    )
    assert repo.last_source_id is None


@pytest.mark.asyncio
async def test_run_locate_keeps_opaque_source_id(tmp_path):
    lib = _make_library_repo(tmp_path)
    repo = _FakeChunkRepo([])
    await locate.run_locate(
        question="…", lang="ru",
        router_args={"source_id": "source_NoY8sAlXF1IT"},
        chunk_repo=repo, embedder=_FakeEmbedder(), pool=None, library_repo=lib,
    )
    assert repo.last_source_id == "source_NoY8sAlXF1IT"


@pytest.mark.asyncio
async def test_run_locate_queries_both_attribution_kinds(tmp_path, monkeypatch):
    # Regression: locate must consult BOTH pinned- and boost-kind
    # attributions (seeded stories are boost-kind). Bug A.
    lib = _make_library_repo(tmp_path)
    seen: dict[str, dict] = {}

    async def _fake_find(**kw):
        seen[kw["kind"]] = kw
        return []

    monkeypatch.setattr(locate, "find_attributions", _fake_find)
    await locate.run_locate(
        question="история Махараджи Прахлады", lang="ru", router_args={},
        chunk_repo=_FakeChunkRepo([]), embedder=_FakeEmbedder(),
        pool=object(), llm=None, embed_model="m", embed_dim=8, library_repo=lib,
    )
    assert set(seen) == {"pinned", "boost"}
    # Boost lookup uses the lowered locate-specific accept thresholds so a
    # full-question-vs-topic-label match (~0.63) isn't rejected by the global
    # 0.70/0.65 bar. Pinned lookup keeps the defaults.
    assert seen["boost"]["accept_native"] == locate._LOCATE_BOOST_ACCEPT_NATIVE
    assert seen["boost"]["accept_cross"] == locate._LOCATE_BOOST_ACCEPT_CROSS
    assert "accept_native" not in seen["pinned"]


@pytest.mark.asyncio
async def test_run_locate_attribution_excludes_semantic_noise(tmp_path, monkeypatch):
    # When a curated attribution matches, its scope is authoritative — a
    # stray semantic hit (12.2) must NOT pollute the curated chapter list.
    from lectorium_chat.research.models import AttributionMatch, AttributionRef

    lib = _make_library_repo(tmp_path)

    async def _fake_find(**kw):
        if kw["kind"] == "boost":
            return [AttributionMatch(
                attribution_id="a1", kind="boost",
                refs=[AttributionRef(ref_kind="title", target_id=f"{SB}/12.8")],
                score=0.9, stage="native",
            )]
        return []

    monkeypatch.setattr(locate, "find_attributions", _fake_find)
    repo = _FakeChunkRepo([_scored("verse", SB, "12.2.5", "ШБ 12.2.5", 0.8)])
    res = await locate.run_locate(
        question="история Маркандеи", lang="ru", router_args={},
        chunk_repo=repo, embedder=_FakeEmbedder(), pool=object(), llm=None,
        embed_model="m", embed_dim=8, library_repo=lib,
    )
    assert len(res.regions) == 1
    assert [c.tokens for c in res.regions[0].chapters] == ["12.8"]
    assert "a1" in res.matched_attribution_ids


@pytest.mark.asyncio
async def test_run_locate_empty_when_no_hits(tmp_path):
    lib = _make_library_repo(tmp_path)
    result = await locate.run_locate(
        question="где про квантовую механику",
        lang="ru", router_args={},
        chunk_repo=_FakeChunkRepo([]), embedder=_FakeEmbedder(),
        pool=None, library_repo=lib,
    )
    assert result.regions == [] and result.verses == []


# ── graph-level wiring: router → locate_worker → synthesizer ──────────────

from dataclasses import dataclass, field  # noqa: E402
from typing import Any  # noqa: E402

from lectorium_chat.agent.graph import build_chat_graph  # noqa: E402
from lectorium_chat.agent.marker_expander import MarkerExpander  # noqa: E402
from lectorium_chat.agent.turn_aliases import TurnAliasMap  # noqa: E402
from lectorium_chat.domain.routing import RoutingDecision  # noqa: E402
from lectorium_chat.agent.graph.turn_context import TurnContext  # noqa: E402


@dataclass
class _FakeLLM:
    router_responses: list = field(default_factory=list)
    stream_responses: list = field(default_factory=list)
    _ridx: int = 0
    _sidx: int = 0

    async def structured_output(self, messages, schema, *, model=None, callbacks=None, run_name=None):
        resp = self.router_responses[self._ridx]
        self._ridx += 1
        return resp

    async def stream_completion(self, messages, *, tools=None, tool_choice=None, model=None,
                                temperature=None, callbacks=None, run_name=None):
        chunks = self.stream_responses[self._sidx]
        self._sidx += 1
        for c in chunks:
            yield c


@pytest.mark.asyncio
async def test_graph_locate_intent_emits_chapter_payload_and_marker(tmp_path):
    lib = _make_library_repo(tmp_path)
    llm = _FakeLLM(
        router_responses=[RoutingDecision(intent="locate", confidence=0.9)],
        # locate is code-driven (no worker LLM stream); only the synthesizer
        # streams — and it cites the chapter region as [^1].
        stream_responses=[
            [{"text": "Это в Седьмой песни: [^1]"}, {"finish_reason": "stop"}],
        ],
    )
    aliases = TurnAliasMap()
    ctx = TurnContext(
        request_id="r-locate",
        aliases=aliases,
        expander=MarkerExpander(aliases),
        llm=llm,
        chunk_repo=_FakeChunkRepo([
            _scored("verse", SB, "12.8.10", "ШБ 12.8.10", 0.71),
            _scored("verse", SB, "12.9.1", "ШБ 12.9.1", 0.66),
            _scored("title", SB, "12.10", "ШБ 12.10", 0.63),
        ]),
        embedder=_FakeEmbedder(),
        library_repo=lib,
    )
    graph = build_chat_graph()

    deltas: list[str] = []
    actions: list[dict] = []
    async for mode, payload in graph.astream(
        {"history": [], "user_query": "в какой песни ШБ история Маркандеи",
         "lang": "ru", "request_id": "r-locate"},
        context=ctx,
        stream_mode=["custom"],
    ):
        if mode == "custom" and payload.get("type") == "delta":
            deltas.append(payload["data"]["text"])
        elif mode == "custom" and payload.get("type") == "action":
            actions.append(payload["data"])

    text = "".join(deltas)
    # Marker expanded server-side to the chapter widget.
    assert "[chapter:source_SB/12" in text
    # Chapter payload emitted BEFORE the marker, carrying titles verbatim.
    chapter_actions = [a for a in actions if a.get("kind") == "chapter"]
    assert len(chapter_actions) == 1
    payload = chapter_actions[0]["payload"]
    assert payload["source_id"] == SB and payload["region_token"] == "12"
    toks = [c["tokens"] for c in payload["chapters"]]
    assert toks == ["12.8", "12.9", "12.10"]


# ---- build_pinned_chapter_notes (research SHORT-path title refs) -----------


class _FakeAliasMap:
    """Records alias_chapter calls; returns a 1-based int alias like the real one."""

    def __init__(self) -> None:
        self.chapters: list[tuple] = []

    def alias_chapter(self, source_id, region_token, region_label, chapters):
        self.chapters.append((source_id, region_token, region_label, tuple(chapters)))
        return len(self.chapters)


class _FakeChunkRepoByTarget:
    """target_id → chunks. A value may be a plain list (lang-agnostic) or a
    {lang: [chunks]} dict; for the dict form, `lang=None` returns the FIRST
    variant (mimicking prod's lang=None picking whichever row comes first)."""

    def __init__(self, by_target: dict) -> None:
        self.by_target = by_target

    async def get_chunks_by_target(self, *, ref_kind, target_id, lang=None):
        val = self.by_target.get(target_id, [])
        if isinstance(val, dict):
            if lang is None:
                return next(iter(val.values()), [])
            return val.get(lang, [])
        return val


def _verse_chunk(source_id, tokens, addr_label, lang="ru"):
    return LibraryChunk(
        item_id=f"v_{tokens}", item_kind="verse", source_id=source_id,
        tokens=tokens, author_id=None, doc_date=None, lang=lang,
        segment_index=0, text="…", addr_label=addr_label,
    )


@pytest.mark.asyncio
async def test_build_pinned_chapter_notes_3level_canto_region(tmp_path):
    # 3-level book (SB canto.chapter.verse): title ref to chapter 12.8 + a verse
    # ref → one canto-12 region with the 12.8 chapter row.
    from lectorium_chat.research.models import AttributionRef

    lib = _make_library_repo(tmp_path)
    repo = _FakeChunkRepoByTarget({"verse_x": [_verse_chunk(SB, "12.8.10", "ШБ 12.8.10")]})
    am = _FakeAliasMap()
    refs = [
        AttributionRef(ref_kind="title", target_id=f"{SB}/12.8"),
        AttributionRef(ref_kind="verse", target_id="verse_x"),
    ]
    notes = await locate.build_pinned_chapter_notes(
        refs, chunk_repo=repo, library_repo=lib, lang="ru", alias_map=am, score=0.9,
    )
    assert len(notes) == 1
    assert notes[0]["type"] == "location"
    assert notes[0]["ref"] == 1
    src, region_token, region_label, chapters = am.chapters[0]
    assert src == SB
    assert region_token == "12"
    assert region_label == "Песнь 12 «Век деградации»"
    assert chapters == (("12.8", "Молитвы Маркандейи Нара-Нараяне Риши"),)


@pytest.mark.asyncio
async def test_build_pinned_chapter_notes_2level_book_label_from_verse(tmp_path):
    # 2-level book (CC chapter.verse): the region is book-level (region_token="")
    # and its label must come from the verse's short-name ("ЧЧ Мадхья"), NOT the
    # title hit's addr_label (the chapter heading). Mirrors the real brahmana pin.
    from lectorium_chat.research.models import AttributionRef

    CC = "source_CC"
    db = tmp_path / "cc.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE library_titles (source_id TEXT, tokens TEXT, language TEXT, title TEXT)")
    conn.execute(
        "INSERT INTO library_titles VALUES (?,?,?,?)",
        (CC, "9", "ru", "Паломничество Шри Чайтаньи Махапрабху"),
    )
    conn.commit()
    conn.close()
    lib = SqliteLibraryRepository(db)

    # Verse resolves to BOTH en and ru variants; en is first (mimics lang=None
    # leaking the EN "CC Madhya"). Fix B must request lang="ru" → "ЧЧ Мадхья".
    repo = _FakeChunkRepoByTarget({"v9": {
        "en": [_verse_chunk(CC, "9.102", "CC Madhya 9.102", lang="en")],
        "ru": [_verse_chunk(CC, "9.102", "ЧЧ Мадхья 9.102", lang="ru")],
    }})
    am = _FakeAliasMap()
    refs = [
        AttributionRef(ref_kind="title", target_id=f"{CC}/9"),
        AttributionRef(ref_kind="verse", target_id="v9"),
    ]
    notes = await locate.build_pinned_chapter_notes(
        refs, chunk_repo=repo, library_repo=lib, lang="ru", alias_map=am, score=0.9,
    )
    assert len(notes) == 1
    src, region_token, region_label, chapters = am.chapters[0]
    assert src == CC
    assert region_token == ""           # book-level region for a 2-level book
    # ru variant wins (NOT the EN "CC Madhya" a lang=None lookup would leak).
    assert region_label == "ЧЧ Мадхья"
    assert chapters == (("9", "Паломничество Шри Чайтаньи Махапрабху"),)


@pytest.mark.asyncio
async def test_build_pinned_chapter_notes_no_title_returns_empty(tmp_path):
    from lectorium_chat.research.models import AttributionRef

    lib = _make_library_repo(tmp_path)
    notes = await locate.build_pinned_chapter_notes(
        [AttributionRef(ref_kind="verse", target_id="verse_x")],
        chunk_repo=_FakeChunkRepoByTarget({}), library_repo=lib, lang="ru",
        alias_map=_FakeAliasMap(), score=0.9,
    )
    assert notes == []
