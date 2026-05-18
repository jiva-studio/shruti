"""Application use-case: run one proactive (agent-initiated) chat turn.

Mirrors `run_chat_turn` but swaps the system prompt for a rule-specific
one and synthesises the user message from `rule_context`. The same
tool registry and LLM loop are reused so action markers, citation
rules, and grounding behaviour are unchanged.
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Awaitable, Callable

from lectorium_chat.agent.events import AgentEvent
from lectorium_chat.agent.llm_loop import run_llm_loop
from lectorium_chat.agent.proactive_prompts import (
    build_synthetic_user_message,
    build_system_prompt,
)
from lectorium_chat.agent.tools import (
    EMITS_EVENTS,
    TOOL_SCHEMAS,
    TOOLS,
    build_personalized_tools,
)
from lectorium_chat.config import get_settings
from lectorium_chat.domain import UserContext


async def run_proactive_turn(
    rule_kind: str,
    rule_context: dict[str, Any],
    *,
    lang: str = "ru",
    request_id: str | None = None,
    user_context: UserContext | None = None,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run one proactive turn end-to-end, yielding agent events as they stream."""
    settings = get_settings()
    system_prompt = build_system_prompt(rule_kind, lang)
    user_message = build_synthetic_user_message(rule_kind, rule_context)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ]
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
