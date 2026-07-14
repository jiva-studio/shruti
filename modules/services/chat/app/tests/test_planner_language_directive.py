"""The planner-side writers (synthesis_planner / intro_writer /
conclusion_writer) must carry the human language NAME in their
`Language:` directive, not a bare locale code.

A bare "sr-Cyrl" makes the LLM answer in Russian — the synthesizer already
resolves the name from the catalog `languages` table, but the planner
streams its intro to the client WITHOUT a synthesizer re-pass, so the same
fix has to live here too. This mirrors `tests/test_language_directive.py`
(synthesizer side) one node upstream.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes.synthesis_planner import (
    synthesis_planner_node,
)
from lectorium_chat.research import outline_builder
from lectorium_chat.research.models import Outline, Thesis


@dataclass
class _Catalog:
    """Stand-in catalog repo: maps a locale to its human name."""

    names: dict[str, str]

    async def language_name(self, code: str) -> str | None:
        return self.names.get(code)


@dataclass
class _Ctx:
    llm: Any | None = None
    request_id: str = "req-test"
    langfuse_trace_id: str = ""
    embedder: Any | None = None
    chunk_repo: Any | None = None
    catalog_repo: Any | None = None
    aliases: Any | None = None
    reranker: Any | None = None


@dataclass
class _Runtime:
    context: _Ctx = field(default_factory=_Ctx)


class _LLM:
    """Records the user-message content of every LLM call so the test can
    inspect the `Language:` directive the writers emitted."""

    def __init__(self, outline: Outline) -> None:
        self._outline = outline
        self.user_messages: list[str] = []

    def _record(self, messages) -> None:
        user = next(
            (m["content"] for m in messages if m.get("role") == "user"), ""
        )
        self.user_messages.append(user)

    async def structured_output(self, messages, schema, *, model=None, **_extra):
        # Only the planner's Outline still goes through structured_output.
        self._record(messages)
        return self._outline

    async def text_completion(self, messages, *, model=None, run_name=None) -> str:
        # intro_writer / conclusion_writer — plain text; empty is fine, the
        # test only asserts on the `Language:` directive they carried.
        self._record(messages)
        return ""


def _directive_lines(messages: list[str]) -> list[str]:
    out: list[str] = []
    for m in messages:
        for line in m.splitlines():
            if line.startswith("Language:"):
                out.append(line)
    return out


@pytest.mark.asyncio
async def test_planner_writers_get_human_language_name(monkeypatch) -> None:
    """For a non-en/ru locale (sr-Cyrl) every planner-side writer's
    `Language:` line carries the resolved human NAME, not the bare code."""
    # Two theses → intro_writer + conclusion_writer both fire.
    outline = Outline(theses=[
        Thesis(thesis="t1", supporting_notes=[1]),
        Thesis(thesis="t2", supporting_notes=[1]),
    ])
    llm = _LLM(outline)
    ctx = _Ctx(
        llm=llm,
        catalog_repo=_Catalog({"sr-Cyrl": "Srpski"}),
    )
    rt = _Runtime(context=ctx)

    # Stub out the post-outline grounding stages so the node runs without
    # an embedder / chunk_repo / stream writer — we only care about the
    # directive that reached the writers.
    async def _noop_rerank(outline, *a, **k):
        return outline, []

    async def _noop_augment(outline, *a, **k):
        return outline, []

    async def _noop_flush(_ctx):
        return None

    monkeypatch.setattr(
        "lectorium_chat.agent.graph.nodes.synthesis_planner."
        "rerank_and_attach_commentaries", _noop_rerank,
    )
    monkeypatch.setattr(
        "lectorium_chat.agent.graph.nodes.synthesis_planner."
        "augment_thin_theses", _noop_augment,
    )
    monkeypatch.setattr(
        "lectorium_chat.agent.graph.nodes.synthesis_planner."
        "flush_card_payloads", _noop_flush,
    )
    monkeypatch.setattr(
        "lectorium_chat.agent.graph.nodes.synthesis_planner."
        "translate_commentaries", _noop_flush,
    )

    async def _noop_retrieval_lang(*a, **k):
        return "en"

    monkeypatch.setattr(
        "lectorium_chat.agent.graph.nodes.synthesis_planner."
        "resolve_retrieval_lang", _noop_retrieval_lang,
    )

    # No real LangGraph stream writer in a unit test.
    monkeypatch.setattr(
        "lectorium_chat.agent.graph.nodes.synthesis_planner."
        "get_stream_writer", lambda: (lambda _e: None),
    )

    state = {
        "user_query": "q",
        "lang": "sr-Cyrl",
        "tool_results": [
            {"type": "lecture", "text": "x", "score": 0.8, "meta": {}}
        ],
        "config": {"enable_early_intro": False},
    }
    await synthesis_planner_node(state, rt)

    lines = _directive_lines(llm.user_messages)
    # planner + intro_writer (+ conclusion fallback may or may not fire,
    # but planner + intro definitely do).
    assert len(lines) >= 2
    for line in lines:
        assert "Srpski" in line, line
        assert line.strip() != "Language: sr-Cyrl", line


@pytest.mark.asyncio
async def test_build_outline_directive_falls_back_to_code() -> None:
    """No name resolved (lang_name=None) → the directive degrades to the
    bare code rather than an empty `Language:` line."""
    llm = _LLM(Outline(theses=[Thesis(thesis="t1", supporting_notes=[1])]))
    await outline_builder.build_outline(
        "q", "sr-Cyrl",
        [{"type": "lecture", "text": "x", "score": 0.8, "meta": {}}],
        llm=llm, lang_name=None,
    )
    assert any("Language: sr-Cyrl" in m for m in llm.user_messages)


def test_lang_directive_helper() -> None:
    assert outline_builder._lang_directive("sr-Cyrl", "Srpski") == "Srpski (sr-Cyrl)"
    assert outline_builder._lang_directive("sr-Cyrl", None) == "sr-Cyrl"
