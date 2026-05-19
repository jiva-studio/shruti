"""Application use-case: run one chat turn.

Composes the orchestration the API endpoint needs — message build,
per-turn user-context binding into personalize tools, then streams
events out of the LLM loop. Adapters (LLM provider, tool registry)
are imported here; the endpoint stays thin.
"""

from __future__ import annotations

import re
from typing import Any, AsyncIterator, Awaitable, Callable

from shruti_chat.agent.aliased_tools import build_aliased_tools
from shruti_chat.agent.events import AgentEvent
from shruti_chat.agent.llm_loop import run_llm_loop
from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.message_builder import build_messages
from shruti_chat.agent.tools import (
    EMITS_EVENTS,
    TOOL_SCHEMAS,
    TOOLS,
    build_personalized_tools,
)
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.composition import AppDeps
from shruti_chat.config import get_settings
from shruti_chat.domain import UserContext
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


# Inline chip-class markers the LLM is FORBIDDEN to write directly —
# it must call propose_cite / propose_card / propose_outline so the
# agent can validate the track_id before injecting the marker into
# the stream. Anything matching these regexes in the LLM-typed prose
# is a bypass: log it, optionally cross-reference against the catalog
# to flag fabricated ids.
_CITE_MARKER_RE = re.compile(r"\[cite:([A-Za-z0-9_.-]+)@\d+-\d+(?:\|[^\]]*)?\]")
_CARD_MARKER_RE = re.compile(r"\[card:([A-Za-z0-9_.-]+)\]")
_OUTLINE_MARKER_RE = re.compile(r"\[outline:([A-Za-z0-9_.-]+)\]")


async def _audit_bypass_markers(
    llm_prose: str,
    *,
    deps: AppDeps,
    request_id: str | None,
) -> None:
    """Log every chip-class marker the LLM typed in prose. With
    `propose_cite` / `propose_card` / `propose_outline` in place, the
    correct path injects markers via tool side-events that bypass
    `content_buf` — so anything that DOES appear in the LLM-prose
    buffer is an instruction-following slip we want visible in
    metrics, never silently stripped."""
    findings: list[tuple[str, str]] = []  # (kind, track_id)
    for m in _CITE_MARKER_RE.finditer(llm_prose):
        findings.append(("cite", m.group(1)))
    for m in _CARD_MARKER_RE.finditer(llm_prose):
        findings.append(("card", m.group(1)))
    for m in _OUTLINE_MARKER_RE.finditer(llm_prose):
        findings.append(("outline", m.group(1)))
    if not findings:
        return

    all_ids = list({tid for _kind, tid in findings})
    try:
        valid = set(await deps.catalog_repo.filter_existing_track_ids(all_ids))
    except Exception as exc:
        log.warning(
            "bypass_audit_validation_failed",
            request_id=request_id,
            error=str(exc),
        )
        valid = set()
    for kind, tid in findings:
        log.info(
            "chat_marker_bypassed_tool",
            request_id=request_id,
            kind=kind,
            track_id=tid,
            in_catalog=tid in valid,
        )


async def run_chat_turn(
    history: list[dict[str, Any]],
    *,
    lang: str = "ru",
    request_id: str | None = None,
    user_context: UserContext | None = None,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
    deps: AppDeps | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run one chat turn end-to-end, yielding agent events as they stream.

    Numbered-refs protocol: the LLM never sees real `track_id`s. Tool
    results are post-processed to expose only integer refs the LLM
    cites by (`[cite:N|caption]`, `[card:N]`, `[outline:N]`). The
    `MarkerExpander` filter expands those integers back to real
    catalog ids before the marker hits the client. Action tools that
    take track_ids accept the same integer refs from the LLM and the
    wrapper translates back."""
    settings = get_settings()
    aliases = TurnAliasMap()
    messages = build_messages(history, lang, user_context)
    tools = build_personalized_tools(TOOLS, user_context)
    tools = build_aliased_tools(tools, aliases)
    expander = MarkerExpander(aliases, request_id=request_id)

    async def _on_done(llm_prose: str) -> None:
        if deps is None:
            return
        await _audit_bypass_markers(
            llm_prose, deps=deps, request_id=request_id,
        )

    async for ev in run_llm_loop(
        messages,
        tools=tools,
        tool_schemas=TOOL_SCHEMAS,
        emits_events=EMITS_EVENTS,
        lang=lang,
        model=settings.llm_default,
        request_id=request_id,
        is_disconnected=is_disconnected,
        on_done=_on_done,
    ):
        if ev.type == "delta":
            cleaned = await expander.feed(ev.data.get("text", ""))
            if cleaned:
                yield AgentEvent(type="delta", data={"text": cleaned})
            continue
        # Stream-terminating or stream-resetting events: flush any
        # partial-marker tail FIRST so the client sees its last text
        # before the terminator. `tool_start` wipes the client-side
        # accumulator (the "thinking out loud" prelude), so we drop
        # the buffered tail entirely for it — there's nothing to
        # forward downstream of a wiped bubble.
        if ev.type in ("done", "error"):
            tail = await expander.flush()
            if tail:
                yield AgentEvent(type="delta", data={"text": tail})
        elif ev.type == "tool_start":
            await expander.flush()
        yield ev
