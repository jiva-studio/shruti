"""Application use-case: run one chat turn.

Composes the orchestration the API endpoint needs — message build,
per-turn user-context binding into personalize tools, then streams
events out of the LLM loop. Adapters (LLM provider, tool registry)
are imported here; the endpoint stays thin.
"""

from __future__ import annotations

import re
from typing import Any, AsyncIterator, Awaitable, Callable

from lectorium_chat.agent.aliased_tools import build_aliased_tools
from lectorium_chat.agent.events import AgentEvent
from lectorium_chat.agent.llm_loop import run_llm_loop
from lectorium_chat.agent.marker_expander import MarkerExpander
from lectorium_chat.agent.message_builder import build_messages
from lectorium_chat.agent.tools import (
    EMITS_EVENTS,
    TOOL_SCHEMAS,
    TOOLS,
    build_personalized_tools,
)
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.composition import AppDeps
from lectorium_chat.config import get_settings
from lectorium_chat.domain import UserContext
from lectorium_chat.indexer.library.repo import fetch_verse_body
from lectorium_chat.observability.logging import get_logger


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
    # Pre-mint refs for `current_track_id` and `focus.track_id` so the
    # LLM sees integer refs instead of raw track_ids in the system prompt
    # — same protocol as tool results. Without this, the LLM would try
    # to pass focus/current track_ids verbatim into chunks_get_window,
    # which only accepts integer refs.
    focus_ref: int | None = None
    current_track_ref: int | None = None
    if user_context is not None:
        if user_context.current_track_id:
            current_track_ref = aliases.alias_track(user_context.current_track_id)
        if user_context.focus is not None:
            focus_ref = aliases.alias_chunk(
                user_context.focus.track_id,
                int(user_context.focus.start_ms),
                int(user_context.focus.end_ms),
            )
    messages = build_messages(
        history, lang, user_context,
        focus_ref=focus_ref,
        current_track_ref=current_track_ref,
    )
    tools = build_personalized_tools(TOOLS, user_context)
    tools = build_aliased_tools(tools, aliases)
    expander = MarkerExpander(aliases, request_id=request_id)

    async def _on_done(llm_prose: str) -> None:
        if deps is None:
            return
        await _audit_bypass_markers(
            llm_prose, deps=deps, request_id=request_id,
        )

    # Set of verse-alias ref numbers for which we've already streamed a
    # `verse_payload` to the client. Each tool-call result may mint new
    # verse refs (via aliased_tools._alias_verse_entry → alias_verse).
    # When a `tool` event lands we walk the alias map and flush any
    # fresh verse-refs as `verse_payload` events BEFORE the LLM's prose
    # deltas reach the client — so the mobile has the body cached by
    # the time it parses the `[verse:source_id/tokens|caption]` marker.
    emitted_verse_refs: set[int] = set()

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
            # Before terminating, hand the client the integer→chunk
            # alias map this turn minted. The client persists it on
            # the freshly-finalised assistant message; on the next
            # turn it ships back via `aliases` on the same message in
            # history, and the server uses it to fold this turn's
            # chip markers back into `[cite:N|...]` form so the LLM
            # sees one numbering scheme throughout the conversation.
            # Empty maps are still emitted (the client can treat
            # `aliases: {}` as "no chip markers in this answer").
            if len(aliases) > 0:
                yield AgentEvent(
                    type="aliases",
                    data={"map": aliases.serialize()},
                )
        elif ev.type == "tool_start":
            await expander.flush()
        yield ev
        if ev.type == "tool":
            async for verse_event in _emit_pending_verse_payloads(
                aliases, emitted_verse_refs, settings.library_db_path, request_id,
            ):
                yield verse_event


async def _emit_pending_verse_payloads(
    aliases: TurnAliasMap,
    emitted: set[int],
    library_db,
    request_id: str,
) -> AsyncIterator[AgentEvent]:
    """Yield one `verse_payload` AgentEvent per verse-alias minted since
    the last call. Bodies missing from `library.db` (the version
    indexed in pgvector is ahead of the local SQLite snapshot, or the
    verse was deleted between publish + chat) are skipped silently —
    the mobile falls back to the addr-only chip in that case.

    Fetches sequentially. Typical turn mints ≤ 8 verses; the read is
    cached page-level by SQLite + the OS, so a tight loop is fine."""
    for ref_num, vref in aliases.verse_refs():
        if ref_num in emitted:
            continue
        emitted.add(ref_num)
        try:
            body = await fetch_verse_body(library_db, vref.source_id, vref.tokens)
        except Exception as exc:
            log.warning(
                "verse_payload_fetch_failed",
                request_id=request_id,
                source_id=vref.source_id,
                tokens=vref.tokens,
                error=str(exc),
            )
            continue
        if body is None:
            continue
        yield AgentEvent(
            type="verse_payload",
            data={
                "source_id": vref.source_id,
                "tokens": vref.tokens,
                "addr_label": vref.addr_label or "",
                "sanskrit": body["sanskrit"],
                "transliteration": body["transliteration"],
                "translation": body["translation"],
            },
        )
