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

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._worker_common import build_verse_payload
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


async def _emit_verse_card(ctx: TurnContext, vref, writer, emitted: set) -> None:
    """Build + emit ONE verse card payload at the moment it's cited.

    `build_verse_payload` does the (cheap) DB fetch and, for a non-corpus
    answer, the verse-prose translation — so the translation runs ONLY for
    cited verses, not the whole aliased pool the eager flush would cover.
    Deduped by (source_id, tokens) so a twice-cited verse ships once."""
    key = (vref.source_id, vref.tokens)
    if key in emitted:
        return
    emitted.add(key)
    payload = await build_verse_payload(ctx, vref)
    if payload is None:
        return
    writer(
        {
            "type": "action",
            "data": {
                "kind": "verse",
                "id": f"verse_{vref.source_id}_{vref.tokens}",
                "payload": payload,
            },
        }
    )


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

    # Verse cards already emitted this stream, keyed by (source_id, tokens),
    # so a verse cited twice doesn't ship two identical payloads.
    emitted_verses: set[tuple[str, str]] = set()

    async for event in run_synthesizer_turn(
        state["user_query"],
        tool_results=state.get("tool_results", []),
        llm=ctx.llm,
        expander=ctx.expander,
        system_prompt=system_prompt,
        history=state.get("history") or None,
        outline=state.get("outline"),
        request_id=ctx.request_id,
        callbacks=[cb] if cb is not None else None,
    ):
        # Bridge use-case events into the SSE writer channel. The
        # transport layer (api/chat.py) consumes these via
        # `graph.astream(stream_mode=["custom", ...])`.
        if event.type == "delta":
            writer({"type": "delta", "data": event.data})
        elif event.type == "action":
            # Commentary-card payload emitted mid-stream by the expander,
            # just before the delta carrying its `[commentary:N]` marker.
            # LAZY translation: translate ONLY this cited purport, here, the
            # instant it's cited — instead of pre-translating the whole
            # candidate pool (most of which never reaches the answer). One
            # call per shown card, and none at all for native (ru/en)
            # answers. Awaited before the write so the payload-before-marker
            # ordering holds.
            await _maybe_translate_commentary(ctx, event.data)
            writer({"type": "action", "data": event.data})
        elif event.type == "verse_request":
            # Card-capable client cited a verse: build + (cited-only)
            # translate + emit its payload now, before the marker's delta —
            # instead of the eager flush translating every aliased verse.
            await _emit_verse_card(ctx, event.data["vref"], writer, emitted_verses)
        elif event.type == "done":
            # The use-case's `done` is internal: the wrapper in
            # `application/chat_turn.py` writes the terminal SSE `done`
            # event itself (with the aliases map attached) AND runs the
            # bypass-marker audit on the accumulated delta text — so
            # this node has nothing to do at end-of-stream.
            pass

    return {}
