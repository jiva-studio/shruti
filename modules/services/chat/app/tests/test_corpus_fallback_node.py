"""Unit tests for agent.graph.nodes.corpus_fallback — the out-of-corpus
memory-pass node.

The node: (1) asks a large model for a from-knowledge answer + derived corpus
probes, (2) re-searches the corpus on those probes keeping only score-floored
hits, (3) hands the synthesizer `fallback_mode` + the draft + surviving notes.
Graceful degrade on missing LLM / structured failure / empty answer → `{}`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from shruti_chat.agent.graph.nodes import corpus_fallback as cf
from shruti_chat.agent.graph.nodes.corpus_fallback import MemoryAnswer
from shruti_chat.research.models import FanoutResult


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
    retrieval_lang_code: str | None = None
    author_scope: Any | None = None
    user_id: str = ""


@dataclass
class _Runtime:
    context: _Ctx = field(default_factory=_Ctx)


class _LLM:
    """Scripted structured_output that records its calls."""

    def __init__(self, script: Any) -> None:
        self.script = script
        self.calls: list[Any] = []

    async def structured_output(self, messages, schema, *, model=None, **_extra):
        self.calls.append((messages, schema, model))
        if callable(self.script):
            return self.script()
        return self.script


@pytest.fixture(autouse=True)
def _patch_collaborators(monkeypatch: pytest.MonkeyPatch) -> None:
    # get_stream_writer only works inside a running graph.
    monkeypatch.setattr(cf, "get_stream_writer", lambda: (lambda _payload: None))
    # resolve_retrieval_lang hits the chunk_repo; stub it deterministically.
    async def _lang(_repo, lang, **_kw):
        return lang
    monkeypatch.setattr(cf, "resolve_retrieval_lang", _lang)
    # Card flushing / translation are post-search side-effects; no-op them.
    async def _noop(_ctx):
        return None
    monkeypatch.setattr(cf, "flush_card_payloads", _noop)
    monkeypatch.setattr(cf, "translate_commentaries", _noop)


def _state(**over: Any) -> dict:
    s = {"user_query": "Сколько лет манжари?", "lang": "ru"}
    s.update(over)
    return s


def _note(score: float, ref: int) -> dict:
    return {"type": "lecture", "ref": ref, "label": "", "text": "t",
            "lang": "ru", "score": score, "meta": {}}


@pytest.mark.asyncio
async def test_no_llm_returns_empty():
    """Missing LLM → degrade to the normal refusal (empty update)."""
    out = await cf.corpus_fallback_node(_state(), _Runtime(_Ctx(llm=None)))
    assert out == {}


@pytest.mark.asyncio
async def test_structured_failure_returns_empty(monkeypatch):
    def boom():
        raise RuntimeError("openrouter 503")
    out = await cf.corpus_fallback_node(_state(), _Runtime(_Ctx(llm=_LLM(boom))))
    assert out == {}


@pytest.mark.asyncio
async def test_empty_answer_returns_empty():
    llm = _LLM(MemoryAnswer(in_scope=True, confidence="low", answer="   ",
                            search_queries=["x"]))
    out = await cf.corpus_fallback_node(_state(), _Runtime(_Ctx(llm=llm)))
    assert out == {}


@pytest.mark.asyncio
async def test_out_of_scope_declines_without_answering(monkeypatch):
    """An off-topic question (cooking) → polite decline, NO memory answer,
    NO re-search, fallback_kind=out_of_scope."""
    called = {"n": 0}
    async def fake_fanout(queries, **kwargs):
        called["n"] += 1
        return FanoutResult()
    monkeypatch.setattr(cf, "fanout_search_with_boost", fake_fanout)

    llm = _LLM(MemoryAnswer(in_scope=False, confidence="high",
                            answer="", search_queries=["как варить пельмени"]))
    ctx = _Ctx(llm=llm, embedder=object(), chunk_repo=object(), catalog_repo=object())
    out = await cf.corpus_fallback_node(
        _state(user_query="Как варить пельмени?"), _Runtime(ctx))
    assert out["fallback_mode"] is True
    assert out["fallback_kind"] == "out_of_scope"
    assert out["fallback_answer"] == ""
    assert out["fallback_notes"] == []
    assert called["n"] == 0  # never searches the corpus for an off-topic question


@pytest.mark.asyncio
async def test_memory_pass_uses_fallback_model_and_floors_notes(monkeypatch):
    """Happy path: structured answer + probes → re-search → only notes above
    the score floor survive, draft + fallback_mode written."""
    captured: dict[str, Any] = {}

    async def fake_fanout(queries, **kwargs):
        captured["queries"] = queries
        captured["kwargs"] = kwargs
        # one strong hit (kept), one junk hit (floored out at 0.5)
        return FanoutResult(chunks=[_note(0.72, 1), _note(0.31, 2)])

    monkeypatch.setattr(cf, "fanout_search_with_boost", fake_fanout)

    llm = _LLM(MemoryAnswer(
        in_scope=True, confidence="high",
        disclaimer="В корпусе не нашлось, отвечаю по памяти:",
        answer="Манджари — юные гопи-служанки.",
        search_queries=["манджари служанки", "Рупа-манджари"],
    ))
    ctx = _Ctx(llm=llm, embedder=object(), chunk_repo=object(),
               catalog_repo=object(), aliases=object())
    out = await cf.corpus_fallback_node(_state(), _Runtime(ctx))

    assert out["fallback_mode"] is True
    assert out["fallback_kind"] == "memory"
    assert out["fallback_confidence"] == "high"
    assert out["fallback_disclaimer"] == "В корпусе не нашлось, отвечаю по памяти:"
    assert out["fallback_answer"] == "Манджари — юные гопи-служанки."
    assert out["outline"] is None
    # Only the strong hit survives the floor.
    assert [n["ref"] for n in out["fallback_notes"]] == [1]
    # Memory-pass ran on the configured fallback model (a Claude).
    _msgs, _schema, model = llm.calls[0]
    assert "claude" in model
    # Re-search ran on the derived probes, enumerated as (id, text) tuples.
    assert captured["queries"] == [(0, "манджари служанки"), (1, "Рупа-манджари")]
    assert captured["kwargs"]["rerank_query"] == "Сколько лет манжари?"


@pytest.mark.asyncio
async def test_no_probes_skips_research(monkeypatch):
    """No derived queries → memory-only answer, re-search never called."""
    called = {"n": 0}

    async def fake_fanout(queries, **kwargs):
        called["n"] += 1
        return FanoutResult()

    monkeypatch.setattr(cf, "fanout_search_with_boost", fake_fanout)
    llm = _LLM(MemoryAnswer(in_scope=True, confidence="medium",
                            answer="ответ по памяти", search_queries=[]))
    ctx = _Ctx(llm=llm, embedder=object(), chunk_repo=object(), catalog_repo=object())
    out = await cf.corpus_fallback_node(_state(), _Runtime(ctx))
    assert out["fallback_mode"] is True
    assert out["fallback_answer"] == "ответ по памяти"
    assert out["fallback_notes"] == []
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_research_failure_degrades_to_memory_only(monkeypatch):
    """A re-search blow-up must not fail the turn — answer stands uncited."""
    async def boom_fanout(queries, **kwargs):
        raise RuntimeError("pgvector down")
    monkeypatch.setattr(cf, "fanout_search_with_boost", boom_fanout)
    llm = _LLM(MemoryAnswer(in_scope=True, confidence="high",
                            answer="ответ", search_queries=["q"]))
    ctx = _Ctx(llm=llm, embedder=object(), chunk_repo=object(), catalog_repo=object())
    out = await cf.corpus_fallback_node(_state(), _Runtime(ctx))
    assert out["fallback_mode"] is True
    assert out["fallback_answer"] == "ответ"
    assert out["fallback_notes"] == []
