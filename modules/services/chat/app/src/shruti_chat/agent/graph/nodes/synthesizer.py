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

from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.prompts import build_prompt
from shruti_chat.application.synthesizer_turn import run_synthesizer_turn
from shruti_chat.domain.turn_context import TurnContext
from shruti_chat.observability.langfuse_client import langfuse_node_callback
from shruti_chat.observability.logging import bind_node_role


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
        elif event.type == "done":
            # The use-case's `done` is internal: the wrapper in
            # `application/chat_turn.py` writes the terminal SSE `done`
            # event itself (with the aliases map attached) AND runs the
            # bypass-marker audit on the accumulated delta text — so
            # this node has nothing to do at end-of-stream.
            pass

    return {}
