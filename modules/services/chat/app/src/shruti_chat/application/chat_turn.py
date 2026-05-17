"""Application use-case: run one chat turn.

Composes the orchestration the API endpoint needs — message build,
per-turn user-context binding into personalize tools, then streams
events out of the LLM loop. Adapters (LLM provider, tool registry)
are imported here; the endpoint stays thin.
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Awaitable, Callable

from shruti_chat.agent.events import AgentEvent
from shruti_chat.agent.llm_loop import run_llm_loop
from shruti_chat.agent.message_builder import build_messages
from shruti_chat.agent.tools import (
    EMITS_EVENTS,
    TOOL_SCHEMAS,
    TOOLS,
    build_personalized_tools,
)
from shruti_chat.config import get_settings
from shruti_chat.domain import UserContext


async def run_chat_turn(
    history: list[dict[str, Any]],
    *,
    lang: str = "ru",
    request_id: str | None = None,
    user_context: UserContext | None = None,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run one chat turn end-to-end, yielding agent events as they stream."""
    settings = get_settings()
    messages = build_messages(history, lang, user_context)
    tools = build_personalized_tools(TOOLS, user_context)
    async for ev in run_llm_loop(
        messages,
        tools=tools,
        tool_schemas=TOOL_SCHEMAS,
        emits_events=EMITS_EVENTS,
        lang=lang,
        model=settings.llm_default,
        request_id=request_id,
        is_disconnected=is_disconnected,
    ):
        yield ev
