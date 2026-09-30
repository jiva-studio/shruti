"""Sibling tasks started by a research stage never outlive it.

`run_research`, `_research_path` and `synthesis_planner_node` start helper
tasks with `asyncio.create_task`. A turn cancelled mid-fanout, or a stage that
re-raises a provider-unavailable error, must take those siblings down too, and
the caption task registered on the alias map ends with the turn.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest

from shruti_chat.agent.graph.turn_context import TurnSettings
from shruti_chat.agent.graph.nodes import synthesis_planner as planner_mod
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.ports.llm_provider import ProviderUnavailable
from shruti_chat.observability.metrics import pipeline_stage_counter
from shruti_chat.research import pipeline
from shruti_chat.research.constants import LEAN_POLICY
from shruti_chat.research.models import AttributionRef, Outline, QueryPlan, SubQuery, Thesis
from shruti_chat.research.refs import fetch_refs


async def _hang(*_a: Any, **_k: Any) -> Any:
    await asyncio.sleep(3600)


async def _provider_down(*_a: Any, **_k: Any) -> Any:
    await asyncio.sleep(0)
    raise ProviderUnavailable("provider down")


class _Embedder:
    async def embed_query(self, _q: str) -> list[float]:
        return [0.0] * 8


# A teardown that stops cancelling its siblings waits on them forever; the bound
# turns that into a failure instead of a hung suite.
TEARDOWN_BOUND_S = 5.0


async def _bounded(aw: Any) -> Any:
    return await asyncio.wait_for(aw, timeout=TEARDOWN_BOUND_S)


def _others(before: set[asyncio.Task[Any]]) -> list[asyncio.Task[Any]]:
    """Tasks started since `before` that are still running."""
    return [t for t in asyncio.all_tasks() - before if not t.done()]


async def _settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


def _run_research(**overrides: Any):
    kwargs: dict[str, Any] = dict(
        question="q", lang="ru", router_args={},
        chunk_repo=object(), catalog_repo=None, embedder=_Embedder(),
        alias_map=TurnAliasMap(), llm=None,
    )
    kwargs.update(overrides)
    return pipeline.run_research(**kwargs)


async def test_cancelled_turn_leaves_no_research_sibling_running(monkeypatch) -> None:
    monkeypatch.setattr(pipeline, "plan_queries", _hang)
    monkeypatch.setattr(pipeline, "find_attributions", _hang)
    monkeypatch.setattr(pipeline, "extract_topics", _hang)
    before = asyncio.all_tasks()

    turn = asyncio.create_task(_run_research())
    await _settle()
    assert len(_others(before)) == 4  # the turn + plan, lookup, topics

    turn.cancel()
    with pytest.raises(asyncio.CancelledError):
        await _bounded(turn)
    await _settle()

    assert _others(before) == []


async def test_provider_unavailable_leaves_no_research_sibling_running(monkeypatch) -> None:
    monkeypatch.setattr(pipeline, "plan_queries", _provider_down)
    monkeypatch.setattr(pipeline, "find_attributions", _hang)
    monkeypatch.setattr(pipeline, "extract_topics", _hang)
    before = asyncio.all_tasks()

    with pytest.raises(ProviderUnavailable):
        await _bounded(_run_research())
    await _settle()

    assert _others(before) == []


async def test_fanout_failure_cancels_the_topic_refs_task(monkeypatch) -> None:
    monkeypatch.setattr(pipeline, "extract_topics", _hang)
    monkeypatch.setattr(pipeline, "fanout_search_with_boost", _provider_down)
    before = asyncio.all_tasks()

    with pytest.raises(ProviderUnavailable):
        await _bounded(pipeline._research_path(
            question="q", lang="ru",
            plan=QueryPlan(sub_queries=[
                SubQuery(id=0, type="general", text="q", alt_phrasings=[]),
            ]),
            chunk_repo=object(), catalog_repo=None, embedder=_Embedder(),
            alias_map=TurnAliasMap(), llm=None, router_args={}, expand_model=None,
        ))
    await _settle()

    assert _others(before) == []


async def test_every_caption_task_of_a_turn_is_held_and_cancelled_with_it(
    monkeypatch,
) -> None:
    """Two research passes in one turn each start a caption task; both stay
    referenced (neither replaces the other) and both end with the turn."""
    monkeypatch.setattr(pipeline, "generate_captions", _hang)
    aliases = TurnAliasMap()
    result = pipeline.ResearchResult(
        authoritative_refs=[],
        research_chunks=[{
            "type": "lecture", "ref": 1, "text": "fragment",
            "meta": {"start_ms": 0, "end_ms": 1000},
        }],
        matched_question_ids=[], matched_topic_ids=[],
    )
    for _ in range(2):
        pipeline._kick_caption_gen(
            result, alias_map=aliases, question="q", lang="ru",
            llm=None, model=None, request_id=None,
        )
    tasks = [t for t in asyncio.all_tasks() if t.get_name() == "caption_gen"]
    assert len(tasks) == 2

    aliases.cancel_background()
    await _settle()

    assert all(t.cancelled() for t in tasks)


@dataclass
class _Ctx:
    llm: Any = field(default_factory=object)
    request_id: str = "req"
    settings: Any = TurnSettings()
    langfuse_trace_id: str = ""
    embedder: Any = None
    chunk_repo: Any = None
    catalog_repo: Any = None
    aliases: Any = None
    reranker: Any = None
    author_scope: Any = None
    retrieval_lang_code: str | None = None


@dataclass
class _Runtime:
    context: _Ctx = field(default_factory=_Ctx)


async def test_intro_failure_cancels_the_stage1_task(monkeypatch) -> None:
    outline = Outline(theses=[
        Thesis(thesis="t1", supporting_notes=[1]),
        Thesis(thesis="t2", supporting_notes=[1]),
    ])

    async def _outline(*_a: Any, **_k: Any) -> Outline:
        return outline

    async def _lang(*_a: Any, **_k: Any) -> str:
        return "ru"

    monkeypatch.setattr(planner_mod, "build_outline", _outline)
    monkeypatch.setattr(planner_mod, "resolve_lang_name", _lang)
    monkeypatch.setattr(planner_mod, "resolve_retrieval_lang", _lang)
    monkeypatch.setattr(planner_mod, "rerank_and_attach_commentaries", _hang)
    monkeypatch.setattr(planner_mod, "synthesize_intro", _provider_down)
    before = asyncio.all_tasks()

    state = {
        "user_query": "q", "lang": "ru",
        "tool_results": [{"type": "lecture", "text": "x", "score": 0.7, "meta": {}}],
    }
    with pytest.raises(ProviderUnavailable):
        await _bounded(planner_mod.synthesis_planner_node(state, _Runtime()))
    await _settle()

    assert _others(before) == []


def _plan() -> QueryPlan:
    return QueryPlan(sub_queries=[SubQuery(id=0, type="general", text="q", alt_phrasings=[])])


async def test_lean_path_failure_cancels_the_fanout(monkeypatch) -> None:
    """The pinned-ref fetch and the supplementary fanout run side by side; when
    the fetch re-raises a provider outage the fanout must not outlive it."""
    monkeypatch.setattr(pipeline, "fetch_refs", _provider_down)
    monkeypatch.setattr(pipeline, "fanout_search_with_boost", _hang)
    before = asyncio.all_tasks()

    with pytest.raises(ProviderUnavailable):
        await _bounded(pipeline._lean_path(
            policy=LEAN_POLICY, question_matches=[], plan=_plan(),
            question="q", lang="ru", retrieval_lang_code="ru",
            chunk_repo=object(), catalog_repo=None, embedder=_Embedder(),
            alias_map=TurnAliasMap(), llm=None, router_args={}, expand_model=None,
            library_repo=None, request_id="r", on_event=None, reranker=None,
        ))
    await _settle()

    assert _others(before) == []


class _TopicEmbedder(_Embedder):
    async def embed_queries(self, texts: list[str]) -> list[list[float]]:
        return [[0.0] * 8 for _ in texts]


async def test_topic_lookup_failure_cancels_the_other_lookups(monkeypatch) -> None:
    lookups = 0

    async def _one_down_one_hanging(*_a: Any, **_k: Any) -> Any:
        nonlocal lookups
        lookups += 1
        if lookups == 1:
            return await _provider_down()
        return await _hang()

    async def _no_fanout(*_a: Any, **_k: Any) -> None:
        return None

    monkeypatch.setattr(pipeline, "find_attributions", _one_down_one_hanging)
    monkeypatch.setattr(pipeline, "fanout_search_with_boost", _no_fanout)
    before = asyncio.all_tasks()

    with pytest.raises(ProviderUnavailable):
        await _bounded(pipeline._research_path(
            question="q", lang="ru", plan=_plan(), precomputed_topics=["a", "b"],
            chunk_repo=object(), catalog_repo=None, embedder=_TopicEmbedder(),
            alias_map=TurnAliasMap(), llm=None, router_args={}, expand_model=None,
        ))
    await _settle()

    assert lookups == 2
    assert _others(before) == []


class _RefRepo:
    """The track ref's lookup hangs; the document ref's lookup fails."""

    async def get_chunks_by_track_fragment(self, **_k: Any) -> Any:
        return await _hang()

    async def get_chunks_by_target(self, **_k: Any) -> Any:
        return [SimpleNamespace(item_id="i1", item_kind="commentary", lang="ru", author_id=None)]


class _BrokenLibrary:
    async def fetch_document_body(self, *_a: Any) -> str:
        await asyncio.sleep(0)
        raise ProviderUnavailable("library read failed")


async def test_fetch_refs_failure_cancels_the_other_refs() -> None:
    before = asyncio.all_tasks()

    with pytest.raises(ProviderUnavailable):
        await _bounded(fetch_refs(
            [
                AttributionRef(ref_kind="track", target_id="t1@0-1000"),
                AttributionRef(ref_kind="document", target_id="d1"),
            ],
            chunk_repo=_RefRepo(), alias_map=TurnAliasMap(), lang="ru",
            canonical_score=0.85, library_repo=_BrokenLibrary(),
        ))
    await _settle()

    assert _others(before) == []


async def test_stopping_the_lean_path_cancels_both_stages(monkeypatch) -> None:
    """Stop cancels the turn while the ref fetch and the fanout are in flight:
    both end, both are recorded as cancelled, and the cancellation propagates."""
    monkeypatch.setattr(pipeline, "fetch_refs", _hang)
    monkeypatch.setattr(pipeline, "fanout_search_with_boost", _hang)
    counter = pipeline_stage_counter.labels
    fetch_before = counter(stage="fetch_refs", status="cancelled")._value.get()
    fanout_before = counter(stage="supplementary_fanout", status="cancelled")._value.get()
    before = asyncio.all_tasks()

    turn = asyncio.create_task(pipeline._lean_path(
        policy=LEAN_POLICY, question_matches=[], plan=_plan(),
        question="q", lang="ru", retrieval_lang_code="ru",
        chunk_repo=object(), catalog_repo=None, embedder=_Embedder(),
        alias_map=TurnAliasMap(), llm=None, router_args={}, expand_model=None,
        library_repo=None, request_id="r", on_event=None, reranker=None,
    ))
    await _settle()
    turn.cancel()

    with pytest.raises(asyncio.CancelledError):
        await _bounded(turn)
    await _settle()

    assert _others(before) == []
    assert counter(stage="fetch_refs", status="cancelled")._value.get() == fetch_before + 1
    assert (
        counter(stage="supplementary_fanout", status="cancelled")._value.get()
        == fanout_before + 1
    )
