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

from lectorium_chat.agent.graph.nodes._worker_common import CARD_SPEC_BY_FAMILY
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.prompts import build_prompt
from lectorium_chat.application.synthesizer_turn import run_synthesizer_turn
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.observability.langfuse_client import langfuse_node_callback
from lectorium_chat.observability.logging import bind_node_role, get_logger


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
    card marker is produced, kicks off that card's translation (commentary) or
    build+translate (verse / cite / media / chapter, via its CARD_SPECS entry)
    as a background task. The LLM keeps streaming into a queue while those run.
    The consumer drains the queue in order, awaiting each card's task right
    before writing it — by which point it's usually already done (it has been
    running concurrently with the prose that followed). Ordering (the card's
    `action` before its marker delta) is preserved because the producer
    enqueues them in order and the consumer never reorders.
    """
    emitted_cards: set[tuple] = set()
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
                elif event.type == "card_request":
                    # One generic path for verse / cite / media / chapter —
                    # dispatch on the CARD_SPECS registry, so a new card kind
                    # needs no change here.
                    req = event.data["req"]
                    spec = CARD_SPEC_BY_FAMILY[req.family]
                    key = (req.family, spec.dedup_key(req.ref))
                    if key in emitted_cards:
                        continue
                    emitted_cards.add(key)
                    task = asyncio.ensure_future(spec.build(ctx, req.ref_num, req.ref))
                    await queue.put(("card", (spec, req.ref), task))
                elif event.type == "error":
                    # Empty-completion guard: the synthesizer produced no
                    # prose at all (provider streamed nothing after retry +
                    # fallback). Forward the error frame so the chat_turn
                    # bridge sets had_error → finalize refunds the quota and
                    # the client shows "try again" instead of a blank answer.
                    await queue.put(("error", event.data, None))
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
            elif kind == "card":
                spec, ref = data
                payload = await task
                if payload is not None:
                    writer(
                        {
                            "type": "action",
                            "data": {
                                "kind": spec.action_kind,
                                "id": spec.card_id(ref),
                                "payload": payload,
                            },
                        }
                    )
            elif kind == "error":
                writer({"type": "error", "data": data})
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

    # show_verse: append the show_verse.md section, which pins a terse lead-in
    # + the chain-driving follow-up chips (their MEANING and the verse
    # reference are fixed; the LLM still writes the chip TEXT in the user's
    # language). The prompt lives in agent/prompts/show_verse.md (Langfuse-
    # hosted, .md fallback) like every other section — never inline. `{{ADDR}}`
    # is substituted with the human verse address, same as `{{LANG}}`.
    # Resolve the human language NAME for the directive — a bare locale code
    # ("sr-Latn") makes the LLM drift (answered Russian) on planner-less paths.
    # Sourced from the catalog `languages` table (auto-extends; no hardcode).
    lang_name: str | None = None
    if ctx.catalog_repo is not None:
        try:
            lang_name = await ctx.catalog_repo.language_name(state["lang"])
        except Exception:  # noqa: BLE001 — language hint must never fail the turn
            lang_name = None

    fallback_mode = bool(state.get("fallback_mode"))
    fallback_kind = state.get("fallback_kind", "memory")
    sections = _SYNTH_PROMPT_SECTIONS
    if fallback_mode:
        # Out-of-corpus turn: swap the strict empty-result refusal (`grounding`)
        # for the right memory-pass section.
        #   memory       → `fallback`     (disclaimer + faithful draft + opportunistic cites)
        #   out_of_scope → `out_of_scope` (politely decline; off-topic for this assistant)
        repl = "out_of_scope" if fallback_kind == "out_of_scope" else "fallback"
        sections = tuple(repl if s == "grounding" else s for s in sections)
    elif state.get("intent") == "show_verse":
        sections = _SYNTH_PROMPT_SECTIONS + ("show_verse",)
    system_prompt = build_prompt(sections, lang=state["lang"], lang_name=lang_name)
    if state.get("intent") == "show_verse":
        addr = next(
            (n.get("text") for n in state.get("tool_results", [])
             if n.get("type") == "verse" and n.get("text")),
            "",
        ) or "this verse"
        system_prompt = system_prompt.replace("{{ADDR}}", addr)
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "composing_answer"}})

    # Paint the localized memory-pass disclaimer deterministically, before the
    # prose. The model writes it (in the user's language) as `fallback_disclaimer`
    # — but a prompt-mandated line is dropped intermittently (eval caught the EN
    # case), so we emit it ourselves to guarantee presence + language. `fallback.md`
    # tells the model it's already shown, so it won't repeat it.
    if fallback_mode and fallback_kind == "memory":
        disclaimer = (state.get("fallback_disclaimer") or "").strip()
        if disclaimer:
            writer({"type": "delta", "data": {"text": disclaimer + "\n\n"}})

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
    # In fallback mode the citable pool is the re-searched, score-floored
    # `fallback_notes` — NOT `tool_results`, which still holds the junk pool
    # research_worker retrieved and the planner rejected.
    tool_results = (
        state.get("fallback_notes", []) if fallback_mode
        else state.get("tool_results", [])
    )
    # Only the `memory` fallback carries a draft; `out_of_scope` declines with
    # no draft and no notes (its prompt section is self-contained).
    fallback_answer = (
        state.get("fallback_answer")
        if fallback_mode and fallback_kind == "memory"
        else None
    )
    events = run_synthesizer_turn(
        state["user_query"],
        tool_results=tool_results,
        llm=ctx.llm,
        expander=ctx.expander,
        system_prompt=system_prompt,
        history=state.get("history") or None,
        outline=state.get("outline"),
        memory_note=state.get("memory_note"),
        fallback_answer=fallback_answer,
        fallback_confidence=state.get("fallback_confidence") if fallback_mode else None,
        request_id=ctx.request_id,
        callbacks=[cb] if cb is not None else None,
    )
    await _bridge_synth_events(events, ctx, writer)

    return {}
