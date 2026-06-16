"""Action responder — DETERMINISTIC terminal for a create_action turn that
produced a card. No LLM.

When the action_worker built a card (share_pdf / reminder / smart_library /
pro), the card IS the answer: the user asked for a list / an action, we found
it deterministically, so we just emit the `[action:<kind>|id=…]` marker as the
message text. The client already received the card payload on the SSE `action`
event (the action_worker emitted it); the marker is the inline placement token
the renderer needs. No prose, no follow-up chips — the synthesizer (an LLM)
only added variable framing and stray `[card:…]` citations on what should be a
flat list, which was the source of "multiple cards + prose between them".

The "nothing found" case does NOT come here — `route_after_action` sends it to
the synthesizer, which writes the «не нашёл …» message in the user's language
(the one part that genuinely needs an LLM). This node never emits prose, so it
never needs language handling.
"""

from __future__ import annotations

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.conditional import _ACTION_RESULT_KINDS
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.observability.logging import bind_node_role, get_logger


log = get_logger(__name__)


def _action_marker(state: ChatState) -> str | None:
    """The `[action:<kind>|id=…]` marker for the card the action_worker
    produced this turn, or None if there isn't one (defensive — routing
    guarantees there is)."""
    for note in reversed(state.get("tool_results") or []):
        if not isinstance(note, dict):
            continue
        kind = note.get("kind")
        action_id = note.get("action_id")
        if (
            isinstance(kind, str)
            and kind in _ACTION_RESULT_KINDS
            and isinstance(action_id, str)
            and action_id
        ):
            return f"[action:{kind}|id={action_id}]"
    return None


async def action_responder_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("action_responder")
    ctx = runtime.context
    writer = get_stream_writer()

    marker = _action_marker(state)
    if marker is None:
        # Should not happen — route_after_action only sends a turn here when a
        # card exists. Emit nothing rather than a broken bubble.
        log.warning("action_responder_no_marker", request_id=ctx.request_id)
        return {}

    writer({"type": "status", "data": {"key": "composing_answer"}})
    # The whole message body is the marker — the client parses it into the
    # action card. No prose, no followups. This delta goes straight to the
    # client (chat_turn accumulates it as the persisted answer); it doesn't
    # pass through the synthesizer's marker expander, which is fine — the
    # marker already carries the real `action_id` the card was emitted with.
    writer({"type": "delta", "data": {"text": marker}})
    log.info("action_responder_emitted", request_id=ctx.request_id, marker=marker)
    return {}
