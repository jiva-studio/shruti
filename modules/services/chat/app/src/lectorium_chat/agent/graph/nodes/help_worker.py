"""Help worker — answers "what can you do" / "как сменить регион" /
"что значит зелёный кружок" kind of questions.

`router.intent="help"` routes here. The toolset is just `help_get` —
the in-app help wiki. There's no decision the worker needs to make:
the answer always comes from the bundled help corpus.

We bypass the LLM/ReAct loop entirely and call `help_get` directly
with the user's lang. The synthesizer reads the result from
`state["tool_results"]` and composes prose. This removes a noisy
failure mode where weaker models (Gemini Flash Lite) ignored
`tool_choice="required"` when only one tool was on offer and
answered straight from training data instead — burning a turn and
producing ungrounded help text.
"""

from __future__ import annotations

import time

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.observability.logging import bind_node_role, get_logger


log = get_logger(__name__)


async def help_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("help_worker")
    ctx = runtime.context
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "thinking"}})

    help_fn = ctx.help_tools.get("help_get")
    if help_fn is None:
        log.warning("help_worker_no_tool", request_id=ctx.request_id)
        return {"tool_results": []}

    # Emit tool_start/tool_end so the mobile still shows the "thinking
    # while running help_get" affordance even though we don't go
    # through the ReAct loop.
    writer({"type": "tool_start", "data": {"name": "help_get"}})
    t0 = time.monotonic()
    try:
        body = await help_fn(locale=state.get("lang") or "en")
    except Exception as exc:
        log.exception(
            "help_worker_call_failed", request_id=ctx.request_id, error=str(exc)
        )
        writer({"type": "tool_end", "data": {"name": "help_get"}})
        return {"tool_results": [{"error": str(exc)}]}
    writer({"type": "tool_end", "data": {"name": "help_get"}})
    log.info(
        "tool_call",
        request_id=ctx.request_id,
        agent_role="help_worker",
        tool_name="help_get",
        duration_ms=int((time.monotonic() - t0) * 1000),
    )

    return {"tool_results": [{"type": "help", "text": body}]}
