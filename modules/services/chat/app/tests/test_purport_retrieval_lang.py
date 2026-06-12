"""Regression tests for the purport-language bug: a non-corpus answer
language (uk / sr-*) was getting Russian purports because

  1. `synthesis_planner` passed the ANSWER language to the lazy commentary
     attach instead of the corpus-clamped `retrieval_lang`, and
  2. `commentary_expansion._fetch_one` fell back to `lang=None` on a miss
     and grabbed the purport in whatever language existed.

These cover the shared `resolve_retrieval_lang`, the removed fallback, and
the idempotent `translate_commentaries` (so the planner's late attaches get
translated without re-translating the worker's).
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.research.commentary_expansion import _fetch_one
from lectorium_chat.research.pipeline import resolve_retrieval_lang


# ── resolve_retrieval_lang ───────────────────────────────────────────


class _LangsRepo:
    def __init__(self, langs: list[str]) -> None:
        self._langs = langs

    async def distinct_langs(self) -> list[str]:
        return self._langs


async def test_resolve_retrieval_lang_non_corpus_clamps_to_english() -> None:
    repo = _LangsRepo(["en", "ru"])
    assert await resolve_retrieval_lang(repo, "sr-Cyrl") == "en"
    assert await resolve_retrieval_lang(repo, "uk") == "en"


async def test_resolve_retrieval_lang_corpus_lang_passes_through() -> None:
    repo = _LangsRepo(["en", "ru"])
    assert await resolve_retrieval_lang(repo, "ru") == "ru"
    assert await resolve_retrieval_lang(repo, "en") == "en"


async def test_resolve_retrieval_lang_probe_failure_falls_back_english() -> None:
    class _BoomRepo:
        async def distinct_langs(self) -> list[str]:
            raise RuntimeError("db down")

    assert await resolve_retrieval_lang(_BoomRepo(), "ru") == "en"


# ── _fetch_one — no cross-language fallback ──────────────────────────


class _RecordingRepo:
    """Records every (lang) it was queried with; returns rows only for the
    language it was seeded with."""

    def __init__(self, has_lang: str | None) -> None:
        self.has_lang = has_lang
        self.calls: list[Any] = []

    async def get_chunks_by_verse(
        self, *, source_id: str, tokens: str, kinds: list[str], lang: str | None
    ) -> list[Any]:
        self.calls.append(lang)
        return ["CHUNK"] if lang == self.has_lang else []


async def test_fetch_one_miss_returns_empty_without_lang_none_fallback() -> None:
    # Repo only has the RU purport; we ask for EN → must NOT fall back to
    # lang=None (which would have returned the Russian one).
    repo = _RecordingRepo(has_lang="ru")
    out = await _fetch_one(repo, source_id="s", tokens="2.13", lang="en")
    assert out == []
    assert repo.calls == ["en"]  # one query, never lang=None


async def test_fetch_one_hit_returns_chunks() -> None:
    repo = _RecordingRepo(has_lang="en")
    out = await _fetch_one(repo, source_id="s", tokens="2.13", lang="en")
    assert out == ["CHUNK"]
    assert repo.calls == ["en"]


# ── translate_commentaries — idempotent skip-guard ───────────────────


class _CountingTranslator:
    def __init__(self) -> None:
        self.calls = 0

    async def translate(self, text: str, *, src_lang: str, tgt_lang: str) -> str:
        self.calls += 1
        # Line-preserving "translation" so the joined-then-split path keeps
        # alignment and flags mt=True.
        return "\n".join("ru:" + ln for ln in text.split("\n"))


def _ctx_with_commentary() -> tuple[TurnContext, TurnAliasMap, _CountingTranslator, int]:
    am = TurnAliasMap()
    n = am.alias_commentary(
        "doc1", 0, addr_label="BG 2.13", author_name="A", sentences=("S0.", "S1.")
    )
    tr = _CountingTranslator()
    ctx = TurnContext(lang="sr-Cyrl", translate_citations=True, translator=tr, aliases=am)
    return ctx, am, tr, n


async def test_translate_commentaries_is_idempotent() -> None:
    from lectorium_chat.agent.graph.nodes._worker_common import translate_commentaries

    ctx, am, tr, n = _ctx_with_commentary()
    await translate_commentaries(ctx)
    assert am.resolve(n).sentences_translated is not None
    assert am.resolve(n).mt is True
    first = tr.calls
    assert first > 0
    # Second pass (mirrors research_worker → synthesis_planner) must skip the
    # already-translated ref — no extra translator calls.
    await translate_commentaries(ctx)
    assert tr.calls == first


async def test_translate_commentaries_translates_only_new_refs() -> None:
    from lectorium_chat.agent.graph.nodes._worker_common import translate_commentaries

    ctx, am, tr, _ = _ctx_with_commentary()
    await translate_commentaries(ctx)
    calls_after_first = tr.calls
    # A purport attached LATER (the planner's lazy attach) gets picked up on
    # the next pass; the earlier one is skipped.
    n2 = am.alias_commentary(
        "doc2", 0, addr_label="ISO 7", author_name="A", sentences=("T0.",)
    )
    await translate_commentaries(ctx)
    assert tr.calls > calls_after_first
    assert am.resolve(n2).sentences_translated is not None
