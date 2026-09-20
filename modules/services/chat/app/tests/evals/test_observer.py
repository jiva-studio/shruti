"""Tests for the eval observer — drives the chat graph with FakeLLM
and verifies that a TurnObservation captures intent + tool_chain +
response_text correctly.

This is the same wiring the live eval runner will use against
OpenRouter; FakeLLM here keeps the test deterministic and free.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, TypeVar

import pytest
import structlog
from pydantic import BaseModel

from lectorium_chat.agent.graph import build_chat_graph
from lectorium_chat.agent.graph.nodes import research_worker as research_worker_node_mod
from lectorium_chat.agent.marker_expander import MarkerExpander
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain.entities import CompletionChunk, Message
from lectorium_chat.domain.routing import RoutingDecision
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.research.models import ResearchResult
from tests.evals.observer import install_capture_processor, observe_turn
from tests.evals.run_chunk_tools_eval import evaluate_case


T = TypeVar("T", bound=BaseModel)


@dataclass
class FakeLLM:
    """Scripted router (structured_output) + worker/synth (stream)."""

    router_responses: list[RoutingDecision] = field(default_factory=list)
    stream_responses: list[list[CompletionChunk]] = field(default_factory=list)
    _ridx: int = 0
    _sidx: int = 0

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        **_kwargs: Any,
    ) -> T:
        # **_kwargs catches future-added params (e.g. `run_name` for
        # Langfuse span labels) without breaking this mock every time
        # the real LLMPort signature grows.
        resp = self.router_responses[self._ridx]
        self._ridx += 1
        return resp  # type: ignore[return-value]

    async def stream_completion(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        callbacks: list[Any] | None = None,
        **_kwargs: Any,
    ) -> AsyncIterator[CompletionChunk]:
        # **_kwargs catches future-added params (e.g. `run_name` for
        # Langfuse span labels) so this mock survives signature growth.
        chunks = self.stream_responses[self._sidx]
        self._sidx += 1
        for c in chunks:
            yield c


def _tool_call_chunk(*, idx: int, tc_id: str, name: str, args: str) -> CompletionChunk:
    return {
        "tool_calls": [
            {"index": idx, "id": tc_id, "name": name, "arguments_delta": args}
        ]
    }


def _make_ctx(
    llm: FakeLLM,
    tools: dict[str, Any],
    *,
    role: str = "research",
    **fields: Any,
) -> TurnContext:
    """`role` picks which per-worker tool bag `tools` lands in, so a test
    can drive the lane that actually dispatches tools instead of leaning
    on research_worker's ReAct fallback."""
    aliases = TurnAliasMap()
    return TurnContext(
        request_id="obs-test",
        aliases=aliases,
        expander=MarkerExpander(aliases),
        llm=llm,
        **{f"{role}_tools": tools},
        **fields,
    )


def _pipeline_collaborators() -> dict[str, Any]:
    """What research_worker requires before it will run the production
    pipeline. Stubs — the pipeline itself is monkeypatched; what's under test
    is which lane the node picks. It was five fields until #1563 put the raw
    attribution lookup behind a port and pool / embed_model / embed_dim left
    TurnContext with it."""
    return {
        "chunk_repo": object(),
        "embedder": object(),
    }


@pytest.mark.asyncio
async def test_observer_captures_direct_chat_intent() -> None:
    """direct_chat → router runs, no worker, synth answers. Observation
    has intent set, empty tool_chain, response from synth."""
    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="direct_chat", confidence=0.95),
        ],
        stream_responses=[
            [{"text": "Привет! Чем помочь?"}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(llm, tools={})

    obs = await observe_turn("привет", graph=graph, base_ctx=ctx, lang="ru")

    assert obs.intent == "direct_chat"
    assert obs.tool_chain == []
    assert "Привет" in obs.response_text


@pytest.mark.asyncio
async def test_observer_runs_the_production_research_pipeline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """research intent → the code-driven `run_research` pipeline, the
    same lane production runs.

    The harness used to reach `research_worker` with all five pipeline
    collaborators unset, so every research case silently ran the legacy
    ReAct loop instead (#1566). Assert the lane, not just the output."""
    seen: dict[str, Any] = {}

    async def fake_run_research(**kwargs: Any) -> ResearchResult:
        seen.update(kwargs)
        return ResearchResult()

    monkeypatch.setattr(
        research_worker_node_mod, "run_research", fake_run_research
    )

    async def search_x(*, q: str) -> dict[str, Any]:
        raise AssertionError("ReAct tool dispatched on the pipeline lane")

    collaborators = _pipeline_collaborators()
    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="research", confidence=0.9, extracted_args={"topic": "karma"}),
        ],
        stream_responses=[
            [{"text": "Карма обсуждается в лекциях..."}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(llm, tools={"search_x": search_x}, **collaborators)

    obs = await observe_turn(
        "найди про карму", graph=graph, base_ctx=ctx, lang="ru"
    )

    assert obs.react_fallback is False
    assert seen["question"] == "найди про карму"
    # The observer must hand the collaborators through untouched — the
    # bug was a hand-rolled TurnContext rebuild that dropped them.
    for name, value in collaborators.items():
        assert seen[name] is value
    assert obs.intent == "research"
    assert obs.confidence == 0.9
    assert obs.tool_names == []
    assert "Карма" in obs.response_text


@pytest.mark.asyncio
async def test_observer_flags_react_fallback_when_collaborators_missing() -> None:
    """Without the pipeline collaborators `research_worker` degrades to
    the ReAct loop. The observation must SAY SO — the eval runner fails
    the case on it rather than scoring the wrong lane (#1566)."""

    async def search_x(*, q: str) -> dict[str, Any]:
        return {"hits": [{"ref": 42, "text": f"about {q}"}]}

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(intent="research", confidence=0.9),
        ],
        stream_responses=[
            [
                _tool_call_chunk(idx=0, tc_id="c1", name="search_x", args='{"q": "karma"}'),
                {"finish_reason": "stop"},
            ],
            [{"finish_reason": "stop"}],
            [{"text": "Карма обсуждается в лекциях..."}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(llm, tools={"search_x": search_x})

    obs = await observe_turn(
        "найди про карму", graph=graph, base_ctx=ctx, lang="ru"
    )

    assert obs.react_fallback is True
    assert obs.tool_names == ["search_x"]
    passed, failures = evaluate_case({"expect_intent": "research"}, obs)
    assert not passed
    assert any("ReAct fallback" in f for f in failures)


@pytest.mark.asyncio
async def test_observer_preserves_context_fields_it_does_not_wrap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fields the observer has no business touching (locate_tools,
    lang_code) must survive the wrap. The old rebuild dropped both."""
    captured: dict[str, Any] = {}

    async def fake_owned(ctx: TurnContext) -> None:
        captured["ctx"] = ctx

    async def fake_run_research(**kwargs: Any) -> ResearchResult:
        return ResearchResult()

    monkeypatch.setattr(research_worker_node_mod, "owned_track_ids", fake_owned)
    monkeypatch.setattr(
        research_worker_node_mod, "run_research", fake_run_research
    )

    async def locate_x(*, q: str) -> dict[str, Any]:
        return {}

    llm = FakeLLM(
        router_responses=[RoutingDecision(intent="research", confidence=0.9)],
        stream_responses=[[{"text": "ok"}, {"finish_reason": "stop"}]],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(
        llm, tools={"locate_x": locate_x}, role="locate",
        **_pipeline_collaborators(),
    )

    await observe_turn("where is it", graph=graph, base_ctx=ctx, lang="en")

    wrapped = captured["ctx"]
    assert list(wrapped.locate_tools) == ["locate_x"]
    assert wrapped.lang_code == "en"


@pytest.mark.asyncio
async def test_observer_captures_multi_step_chain_in_order() -> None:
    """Worker calls search_x then search_y — both must appear in
    tool_chain in dispatch order. Driven through `help`, a lane that is
    still ReAct in production."""

    async def search_x(*, q: str) -> dict[str, Any]:
        return {"step": "x", "q": q}

    async def search_y(*, q: str) -> dict[str, Any]:
        return {"step": "y", "q": q}

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(
                intent="find_track", confidence=0.9,
                extracted_args={"history_ref": True},
            ),
        ],
        stream_responses=[
            [_tool_call_chunk(idx=0, tc_id="c1", name="search_x", args='{"q": "a"}'), {"finish_reason": "stop"}],
            [_tool_call_chunk(idx=0, tc_id="c2", name="search_y", args='{"q": "b"}'), {"finish_reason": "stop"}],
            [{"finish_reason": "stop"}],  # converge
            [{"text": "done"}, {"finish_reason": "stop"}],  # synth
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(
        llm, tools={"search_x": search_x, "search_y": search_y}, role="catalog"
    )

    obs = await observe_turn(
        "compound", graph=graph, base_ctx=ctx, lang="en",
        history_summary="recent=1 in_progress=0",
    )

    assert obs.tool_names == ["search_x", "search_y"]
    assert obs.tool_chain[0].args == {"q": "a"}
    assert obs.tool_chain[1].args == {"q": "b"}


@pytest.mark.asyncio
async def test_observer_into_evaluate_case_full_pipeline() -> None:
    """End-to-end: observe a real-shaped turn → run evaluate_case against
    a real-shaped JSONL case. Covers the integration the live eval
    will use.

    Uses a listening-history case because every tool-asserting case in
    chunk_tools.jsonl is on a non-research lane — research is code-driven
    and dispatches no ReAct tools at all."""

    async def user_history_search(*, query: str) -> dict[str, Any]:
        return [{"track_id": "t1", "query": query}]

    llm = FakeLLM(
        router_responses=[
            RoutingDecision(
                intent="find_track", confidence=0.92,
                extracted_args={"history_ref": True},
            ),
        ],
        stream_responses=[
            [
                _tool_call_chunk(
                    idx=0, tc_id="c1", name="user_history_search",
                    args='{"query":"преданное служение"}',
                ),
                {"finish_reason": "stop"},
            ],
            [{"finish_reason": "stop"}],
            [{"text": "Вы слушали лекцию о преданном служении."}, {"finish_reason": "stop"}],
        ],
    )
    graph = build_chat_graph()
    ctx = _make_ctx(
        llm, tools={"user_history_search": user_history_search}, role="catalog"
    )

    obs = await observe_turn(
        "что я недавно слушал про преданное служение",
        graph=graph, base_ctx=ctx, lang="ru",
        history_summary="recent=1 in_progress=0",
    )

    # Real-shaped case from chunk_tools.jsonl
    case = {
        "query": "что я недавно слушал про преданное служение",
        "expect_intent": "find_track",
        "expect_tool": "user_history_search",
        "expect_args": {"query": "преданное служение"},
    }
    passed, failures = evaluate_case(case, obs)
    assert passed, f"failures: {failures!r}"


@pytest.mark.asyncio
async def test_react_fallback_is_detected_at_a_quiet_log_level() -> None:
    """The runner's fallback guard must not depend on LOG_LEVEL.

    `_capture_processor` sits in the structlog PROCESSOR chain, but the
    bound logger `setup_logging` installs filters before the chain runs.
    At LOG_LEVEL=warning the info-level `research_worker_react_fallback`
    was therefore dropped before the harness could see it, and the
    "unconditional" guard passed vacuously — measured: the fallback case
    scored `passed=False` at info and `passed=True` at warning, i.e. the
    guard was silently off exactly when logs were quiet.
    """
    saved = structlog.get_config()
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(logging.WARNING),
        cache_logger_on_first_use=False,
    )
    install_capture_processor()
    try:

        async def search_x(*, q: str) -> dict[str, Any]:
            return {"hits": []}

        llm = FakeLLM(
            router_responses=[RoutingDecision(intent="research", confidence=0.9)],
            stream_responses=[
                [
                    _tool_call_chunk(idx=0, tc_id="c1", name="search_x", args='{"q": "karma"}'),
                    {"finish_reason": "stop"},
                ],
                [{"finish_reason": "stop"}],
                [{"text": "Карма..."}, {"finish_reason": "stop"}],
            ],
        )
        graph = build_chat_graph()
        ctx = _make_ctx(llm, tools={"search_x": search_x})

        obs = await observe_turn(
            "найди про карму", graph=graph, base_ctx=ctx, lang="ru"
        )

        assert obs.react_fallback is True
        passed, failures = evaluate_case({"expect_intent": "research"}, obs)
        assert not passed
        assert any("ReAct fallback" in f for f in failures)
    finally:
        structlog.configure(**saved)


# ── harness wiring (tests/evals/_fixtures.py) ───────────────────────────


@pytest.mark.asyncio
async def test_eval_client_puts_the_pipeline_collaborators_on_the_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`_fixtures.EvalChatClient` is the load-bearing half of #1566 and the
    only place the live runner builds a TurnContext.

    `research_worker` drops to the ReAct loop when chunk_repo or embedder is
    None, and the fixture used to hand those to `bind_repositories` only —
    every research case in the offline eval scored a lane production has not
    run since 2026-05-21.
    Build the client with sentinels and assert they arrive on `base_ctx`,
    together with `lang_code` and `locate_tools`, which the same rebuild
    dropped.
    """
    from tests.evals import _fixtures

    sentinels = {
        "chunk_repo": object(),
        "catalog_repo": object(),
        "embedder": object(),
    }
    client = _fixtures.EvalChatClient(
        graph=object(), llm=object(), library_repo=None, **sentinels
    )

    captured: dict[str, Any] = {}

    async def fake_observe_turn(query: str, **kwargs: Any) -> str:
        captured["ctx"] = kwargs["base_ctx"]
        return "obs"

    monkeypatch.setattr(_fixtures, "observe_turn", fake_observe_turn)

    assert await client.observe_turn("найди про карму", lang="en") == "obs"
    ctx = captured["ctx"]

    for name, value in sentinels.items():
        assert getattr(ctx, name) is value, f"{name} never reached the TurnContext"
    # The exact predicate research_worker_node branches on.
    assert not any(
        getattr(ctx, name) is None
        for name in ("chunk_repo", "embedder")
    ), "the live harness would take the ReAct fallback"
    assert ctx.lang_code == "en"
    assert ctx.locate_tools, "locate_tools must be sliced onto the context"
