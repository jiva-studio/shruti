"""Synthesizer node — the singular node that streams the final
response to the client.

Wraps `application/synthesizer_turn.py`. Differences this node owns:

1. Subscribe to LangGraph's writer channel; forward synth's
   `SynthesizerEvent` (type=delta) as `{type:"delta", data:{text}}`.
2. Build the synthesizer's prompt subset (everything that shapes
   the final prose — see `_SYNTH_PROMPT_SECTIONS`).
3. The `done` event from the use-case carries the full pre-expansion
   prose. The chat_turn.py wrapper runs the bypass-marker audit
   after `graph.astream` returns — this node just drops `done` on
   the floor because the wrapper has the full accumulated prose
   already (it sees every `delta`).
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.agent.graph.nodes._worker_common import build_verse_payload
from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.prompts import build_prompt
from shruti_chat.application.synthesizer_turn import run_synthesizer_turn
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.observability.langfuse_client import langfuse_node_callback
from shruti_chat.observability.logging import bind_node_role, get_logger


log = get_logger(__name__)


async def _maybe_translate_commentary(ctx: TurnContext, data: dict) -> None:
    """Translate one commentary card's quote in place — only when needed.

    Fires only for an `action.kind == "commentary"` payload on a non-native
    answer (`retrieval_lang != lang`) with translation opted in. Translates
    the card's shown (cited) text — ONE LLM call per shown card — and records
    the source as `text_original` + `mt` so the client's original toggle
    works. This replaces the eager whole-pool `translate_commentaries` for
    card clients: we translate exactly what the answer cites, nothing more.
    Failure leaves the source text untouched (a citation never fails the
    turn). The translator is cached, so repeats are free.
    """
    if data.get("kind") != "commentary":
        return
    if not (
        ctx.translate_citations
        and ctx.translator is not None
        and ctx.retrieval_lang
        and ctx.retrieval_lang != ctx.lang
    ):
        return
    payload = data.get("payload") or {}
    src = payload.get("text") or ""
    if not src:
        return
    try:
        translated = await ctx.translator.translate(
            src, src_lang=ctx.retrieval_lang, tgt_lang=ctx.lang
        )
    except Exception as exc:  # noqa: BLE001 — a citation never fails the turn
        log.warning(
            "commentary_card_translate_failed",
            request_id=ctx.request_id,
            error=str(exc),
        )
        return
    if translated and translated != src:
        payload["text_original"] = src
        payload["text"] = translated
        payload["mt"] = True


async def _bridge_synth_events(events: Any, ctx: TurnContext, writer: Any) -> None:
    """Forward synthesizer events to the SSE writer, OVERLAPPING citation
    translation with generation.

    The naive version awaited each card's translation inline, which suspended
    the generator → the LLM stopped streaming for ~1.5s per translated card.
    Here a producer task drives the synthesizer stream and, the instant a
    `[commentary:N]`/`[verse:…]` marker is produced, kicks off that card's
    translation (commentary) or build+translate (verse) as a background task.
    The LLM keeps streaming into a queue while those run. The consumer drains
    the queue in order, awaiting each card's task right before writing it —
    by which point it's usually already done (it has been running concurrently
    with the prose that followed). Ordering (the card's `action` before its
    marker delta) is preserved because the producer enqueues them in order and
    the consumer never reorders.
    """
    emitted_verses: set[tuple[str, str]] = set()
    queue: asyncio.Queue = asyncio.Queue()

    async def produce() -> None:
        try:
            async for event in events:
                if event.type == "delta":
                    await queue.put(("delta", event.data, None))
                elif event.type == "action" and event.data.get("kind") == "commentary":
                    # Translate this purport concurrently; consumer awaits it.
                    task = asyncio.ensure_future(_maybe_translate_commentary(ctx, event.data))
                    await queue.put(("action", event.data, task))
                elif event.type == "action":
                    await queue.put(("action", event.data, None))
                elif event.type == "verse_request":
                    vref = event.data["vref"]
                    key = (vref.source_id, vref.tokens)
                    if key in emitted_verses:
                        continue
                    emitted_verses.add(key)
                    # Build (DB fetch) + translate this verse concurrently.
                    task = asyncio.ensure_future(build_verse_payload(ctx, vref))
                    await queue.put(("verse", vref, task))
                # `done` is handled by the chat_turn wrapper — ignore here.
        finally:
            await queue.put((None, None, None))  # sentinel

    producer = asyncio.ensure_future(produce())
    try:
        while True:
            kind, data, task = await queue.get()
            if kind is None:
                break
            if kind == "delta":
                writer({"type": "delta", "data": data})
            elif kind == "action":
                if task is not None:
                    await task  # translation mutated data["payload"] in place
                writer({"type": "action", "data": data})
            elif kind == "verse":
                payload = await task
                if payload is not None:
                    writer(
                        {
                            "type": "action",
                            "data": {
                                "kind": "verse",
                                "id": f"verse_{data.source_id}_{data.tokens}",
                                "payload": payload,
                            },
                        }
                    )
        await producer
    finally:
        if not producer.done():
            producer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await producer


# The synthesizer's "voice" sections — these shape FINAL prose, which
# is what the client sees. Workers don't need most of these because
# their output never reaches the client directly.
#
# `grounding` (formerly the in-code `_GROUNDING_INSTRUCTION` constant
# in `application/synthesizer_turn.py`) ships as a Langfuse-managed
# section so it gets the same hot-reload as the rest. `note_types` is
# the renamed `library` after splitting the blockquote rule out into
# `quoting.md`.
_SYNTH_PROMPT_SECTIONS = (
    "header",
    "no_narration",
    "citations",
    "note_types",
    "quoting",
    "response_shape",
    "actions",
    "language",
    "safety",
    "followups",
    "grounding",
)


async def synthesizer_node(state: ChatState, runtime: Runtime[TurnContext]) -> dict:
    bind_node_role("synthesizer")
    ctx = runtime.context

    if ctx.expander is None:
        raise RuntimeError(
            "synthesizer_node requires runtime.context.expander to be set "
            "(chat_turn.py wrapper builds it from aliases)"
        )
    if ctx.llm is None:
        raise RuntimeError("synthesizer_node requires runtime.context.llm to be set")

    system_prompt = build_prompt(_SYNTH_PROMPT_SECTIONS, lang=state["lang"])
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "composing_answer"}})

    cb = (
        langfuse_node_callback(ctx.langfuse_trace_id, "synthesizer")
        if ctx.langfuse_trace_id
        else None
    )

    # Bridge use-case events into the SSE writer channel, overlapping each
    # cited card's translation with the prose generation that follows it (so
    # translation no longer stalls the stream). The transport layer
    # (api/chat.py) consumes these via `graph.astream(stream_mode=…)`. The
    # `done` event is left for the chat_turn wrapper (terminal SSE + audit).
    events = run_synthesizer_turn(
        state["user_query"],
        tool_results=state.get("tool_results", []),
        llm=ctx.llm,
        expander=ctx.expander,
        system_prompt=system_prompt,
        history=state.get("history") or None,
        outline=state.get("outline"),
        request_id=ctx.request_id,
        callbacks=[cb] if cb is not None else None,
    )
    await _bridge_synth_events(events, ctx, writer)

    return {}
