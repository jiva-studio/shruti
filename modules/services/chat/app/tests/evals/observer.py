"""Observer wrapper around the chat graph for eval runs.

Drives a single chat turn through the production graph and captures a
`TurnObservation` — intent + tool_chain + response_text — for the
predicate matchers in `run_chunk_tools_eval.evaluate_case` to consume.

The observer **does not** run a real LLM by itself; that's the
caller's job (pass in a configured `LLMPort` via `TurnContext`). For
the live eval pass: build an `OpenRouterLLMProvider`, plug in real
repos, pass to `observe_turn`. For unit tests: pass a scripted
`FakeLLM` and inspect what the predicates see.

The capture sources:

- intent / confidence / extracted_args — read from structlog's
  `router_decision` event in `application/router_turn.py:69-76`.
  We hook a structlog processor that pushes those into a per-turn
  list so the observer doesn't depend on the router's internal API.
- tool_chain — built from `tool_start` / `tool` SSE events. The
  worker bridges its `on_tool_event` callback into the writer, so
  every dispatched tool produces one `tool_start` + one `tool`
  event with `{"name": "..."}`. Args/results are NOT in the SSE
  stream; we capture them via the SAME structlog hook (the use-case
  logs `tool_call` after dispatch with name + duration; we extend
  it for args/results below).
- response_text — accumulated from `delta` SSE events.
"""

from __future__ import annotations

import contextvars
import json  # noqa: F401
from dataclasses import dataclass, field
from typing import Any

import structlog

from shruti_chat.agent.graph.state import ChatState  # noqa: F401
from shruti_chat.agent.graph.turn_context import TurnContext
from tests.evals.observation import ToolInvocation, TurnObservation


# Per-turn capture buffer. We use a contextvar so multiple turns can
# observe concurrently without crossing wires (each `observe_turn`
# call binds a fresh buffer).
_capture_buf: contextvars.ContextVar["_CaptureBuf | None"] = contextvars.ContextVar(
    "eval_capture_buf", default=None
)


@dataclass
class _CaptureBuf:
    """Internal mutable state collected during one turn."""

    intent: str | None = None
    confidence: float | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)


def _capture_processor(
    logger: Any, method_name: str, event_dict: dict[str, Any]
) -> dict[str, Any]:
    """Structlog processor: when a router/tool log lands during a
    captured turn, mirror the relevant fields into the active buffer.

    Returns event_dict unchanged (this processor is purely an
    observer; it doesn't modify the log itself)."""
    buf = _capture_buf.get()
    if buf is None:
        return event_dict
    event_name = event_dict.get("event")
    if event_name == "router_decision":
        buf.intent = event_dict.get("intent")
        conf = event_dict.get("confidence")
        if isinstance(conf, (int, float)):
            buf.confidence = float(conf)
    # `tool_call` events are NO LONGER mirrored to buf — the per-tool
    # wrapper in `_wrap_tools_for_capture` is the single source of truth
    # for chain entries (carries name + args + result). Without this
    # split, failing tool calls would land in buf via structlog without
    # args, polluting the chain.
    return event_dict


# Install the capture processor. Must be called AFTER setup_logging()
# (which reconfigures structlog with its own processor list). Idempotent.
def install_capture_processor() -> None:
    cfg = structlog.get_config()
    processors = list(cfg.get("processors") or [])
    if _capture_processor in processors:
        return
    # Insert at the front so the processor sees the full event dict
    # before any renderer touches it.
    processors.insert(0, _capture_processor)
    structlog.configure(processors=processors)


# Also try to install at import (covers tests where setup_logging
# isn't called). The _fixtures.py runner re-installs after lifespan.
install_capture_processor()


# ── Capturing tool wrapper ──────────────────────────────────────────────


def _wrap_tools_for_capture(
    tools: dict[str, Any],
    buf: "_CaptureBuf",
) -> dict[str, Any]:
    """Wrap each tool fn so calls record (name, args, result) into the
    per-turn buffer.

    `buf` is closed over directly — contextvars don't propagate reliably
    through LangGraph's internal task spawning, so we bind by reference.
    Calls fire in react_loop's ReAct loop sequentially, so order
    is deterministic within one turn.
    """
    wrapped: dict[str, Any] = {}
    for n, fn in tools.items():
        async def _w(_n: str = n, _fn: Any = fn, _buf: "_CaptureBuf" = buf, **kwargs: Any) -> Any:
            # Snapshot kwargs BEFORE calling _fn so we capture what the
            # LLM passed even when the underlying tool raises (in which
            # case react_loop._dispatch wraps the exception into
            # `{"error": ...}` and our `await _fn` would have re-raised
            # past us, skipping the append).
            captured_args = {
                k: v for k, v in kwargs.items()
                if k not in ("yield_event", "alias_map", "user_context")
            }
            try:
                result = await _fn(**kwargs)
            except Exception as exc:
                result = {"error": str(exc)}
                _buf.tool_calls.append(
                    {"name": _n, "args": captured_args, "result": result}
                )
                # Re-raise so react_loop's dispatcher sees the same
                # error and records the proper tool message.
                raise
            _buf.tool_calls.append(
                {"name": _n, "args": captured_args, "result": result}
            )
            return result

        wrapped[n] = _w
    return wrapped


# ── Public API ──────────────────────────────────────────────────────────


async def observe_turn(
    query: str,
    *,
    graph: Any,
    base_ctx: TurnContext,
    lang: str = "ru",
    history: list[dict[str, Any]] | None = None,
    focus_ref: int | None = None,
    focus_around_ms: int | None = None,
    current_track_ref: int | None = None,
    now_iso: str | None = None,
    history_summary: str | None = None,
) -> TurnObservation:
    """Run one turn end-to-end through `graph`, return a TurnObservation.

    The caller supplies a `TurnContext` with the LLM + tools already
    wired (production: real OpenRouter; unit tests: FakeLLM + fake
    tools). The observer:

    - wraps the context's tools to record (name, args, result) per call
    - subscribes a per-turn capture buffer so router/tool logs land in it
    - drives `graph.astream` and accumulates delta text

    Returns the populated `TurnObservation` ready for `evaluate_case`.
    """
    buf = _CaptureBuf()
    token = _capture_buf.set(buf)
    try:
        ctx_wrapped = TurnContext(
            request_id=base_ctx.request_id,
            aliases=base_ctx.aliases,
            expander=base_ctx.expander,
            emitted_card_keys=set(),
            llm=base_ctx.llm,
            research_tools=_wrap_tools_for_capture(base_ctx.research_tools, buf),
            catalog_tools=_wrap_tools_for_capture(base_ctx.catalog_tools, buf),
            action_tools=_wrap_tools_for_capture(base_ctx.action_tools, buf),
            help_tools=_wrap_tools_for_capture(base_ctx.help_tools, buf),
            library_db_path=base_ctx.library_db_path,
        )
        state: dict[str, Any] = {
            "history": history or [],
            "user_query": query,
            "lang": lang,
            "request_id": base_ctx.request_id or "eval",
            "tool_results": [],
            "focus_ref": focus_ref,
            "focus_around_ms": focus_around_ms,
            "current_track_ref": current_track_ref,
            "now_iso": now_iso,
            "history_summary": history_summary,
        }

        response_chunks: list[str] = []
        outline_n_theses: int | None = None
        outline_has_intro: bool | None = None
        outline_has_conclusion: bool | None = None
        outline_skipped_notes_ratio: float | None = None
        async for mode, payload in graph.astream(
            state, context=ctx_wrapped, stream_mode=["custom"]
        ):
            if mode != "custom":
                continue
            ev_type = payload.get("type")
            ev_data = payload.get("data", {})
            if ev_type == "delta":
                response_chunks.append(ev_data.get("text", ""))
            elif ev_type == "outline_summary":
                # synthesis_planner_node emits this once per turn when
                # an outline was built. Captures the shape predicates
                # can assert against (n_theses, has_conclusion, …).
                outline_n_theses = ev_data.get("n_theses")
                outline_has_intro = ev_data.get("has_intro")
                outline_has_conclusion = ev_data.get("has_conclusion")
                outline_skipped_notes_ratio = ev_data.get(
                    "skipped_notes_ratio",
                )

        # Tool calls captured via wrapper carry args+result; every
        # invocation (incl. those returning {"error": ...}) is in the
        # chain so the predicates can see what the LLM actually tried.
        tool_chain = [
            ToolInvocation(
                name=tc["name"], args=tc.get("args", {}), result=tc.get("result")
            )
            for tc in buf.tool_calls
        ]

        return TurnObservation(
            intent=buf.intent,
            confidence=buf.confidence,
            tool_chain=tool_chain,
            response_text="".join(response_chunks),
            outline_n_theses=outline_n_theses,
            outline_has_intro=outline_has_intro,
            outline_has_conclusion=outline_has_conclusion,
            outline_skipped_notes_ratio=outline_skipped_notes_ratio,
        )
    finally:
        _capture_buf.reset(token)
