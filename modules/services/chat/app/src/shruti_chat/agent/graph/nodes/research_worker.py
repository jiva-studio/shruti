"""Research worker — semantic + deterministic lookups over the corpus.

Intent `research` lands here. Tools cover semantic search over every
chunk kind (lecture / verse / commentary / prose / letter), exact-
address lookups, similarity, history search, and outline retrieval.
See `_worker_common.run_worker` for the shared body.
"""

from __future__ import annotations

from langgraph.runtime import Runtime

from shruti_chat.agent.graph.nodes._worker_common import run_worker
from shruti_chat.agent.graph.state import ChatState
from shruti_chat.domain.turn_context import TurnContext


async def research_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    result = await run_worker(
        state,
        runtime,
        role="research_worker",
        tools=runtime.context.research_tools,
        status_key="searching_corpus",
    )
    return {"tool_results": result.tool_results}
