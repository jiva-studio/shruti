"""Shared helpers for the worker nodes (research / catalog / action / help).

Every worker is a thin LangGraph adapter that:
  1. Looks up its toolset on `runtime.context` (different attr per worker).
  2. Emits a `status` event so the StatusPill on mobile reflects which
     phase of the turn is running.
  3. Builds the OpenAI-shape tool_schemas from the bound tools.
  4. Optionally renders an "anchor block" header that surfaces the
     UserContext details (focus_ref, current_track_ref, now, history
     summary) the inner LLM needs to pick context-aware tools.
  5. Calls the generic `run_react_loop` ReAct loop with the right
     tools + prompt + tool-event callback.

The use-case (`application/react_loop.py`) is purposely generic — the
"research" in the name is historical. It's the ReAct loop the worker
runs; toolset is parameterised.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.prompts import build_prompt, standalone_prompt
from lectorium_chat.agent.turn_aliases import ChapterRef, ChunkRef, MediaRef, VerseRef
# The card / citation payload layer moved to `agent/cards.py` — it touches
# neither LangGraph nor ChatState. Re-exported so existing call sites keep
# their import path; the definitions live there.
from lectorium_chat.agent.cards import (  # noqa: F401
    CARD_SPECS,
    CARD_SPEC_BY_FAMILY,
    CardSpec,
    build_chapter_payload,
    build_cite_payload,
    build_media_payload,
    build_verse_payload,
    flush_card_payloads,
    localize_citation,
    resolve_track_display,
    translate_commentaries,
)
from lectorium_chat.application.react_loop import (
    DEFAULT_MAX_TURNS,
    ResearchResult,
    run_react_loop,
)
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.application.cache_helpers import TTL_30D, cached_llm_json
from lectorium_chat.config import get_settings
from lectorium_chat.domain.entities import Message
from lectorium_chat.observability.langfuse_client import langfuse_node_callback
from lectorium_chat.research.pipeline import reduce_locale_to_content_lang
from lectorium_chat.observability.logging import bind_node_role, get_logger

from pydantic import BaseModel, Field


log = get_logger(__name__)


class LocalizedReply(BaseModel):
    """A short assistant reply generated in the USER's language."""

    line: str
    chips: list[str] = Field(default_factory=list)


# Overrides the prompt's JSON contract on the retry below. Stays in code rather
# than in the `.md`: it exists only because the TRANSPORT changed
# (`text_completion` instead of `structured_output`), and an editor tuning the
# wording in Langfuse must not be able to break a schema contract.
_PLAIN_LINE_RULE = (
    "Ignore the JSON contract above: return ONLY that one line as plain text. "
    "No JSON, no quotes, no chips, no explanation."
)


async def localized_reply(ctx: TurnContext, situation: str) -> LocalizedReply:
    """One cheap-LLM call that writes a short chat reply in the user's language
    (`ctx.lang_code`) from an English `situation` description: a `line` plus 0-3
    tappable follow-up `chips`. This is how the service localizes fixed replies
    to EVERY shipped locale (es/hi/bn/uk/sr/…), not just a hardcoded ru/en pair
    — same pattern as the find_tracks intro. Degrades to an empty reply on any
    LLM miss so a localization failure never crashes the SSE stream.

    KV-cached by `(situation, lang, model)` for 30 days: these replies are
    deterministic for a given situation+language, so the same "no lectures on
    <ref>" or "name a lecture" phrasing is written by the LLM once and then
    served from cache — no per-turn model call on the hot paths."""
    sys = standalone_prompt("localized-reply", "localized_reply")
    usr = f"Language code: {ctx.lang_code}\nSituation: {situation}"
    msgs: list[Message] = [
        {"role": "system", "content": sys},
        {"role": "user", "content": usr},
    ]
    model = get_settings().llm_cheap

    async def _call() -> LocalizedReply:
        try:
            return await ctx.llm.structured_output(
                msgs, LocalizedReply, model=model, run_name="localized_reply",
            )
        except Exception as exc:  # noqa: BLE001
            # A one-line reply plus up to three chips is too small a thing to
            # lose a turn over, and in production both the primary AND the
            # fallback model failed to emit parseable JSON for it — the user got
            # a blank bubble. Ask again with NO JSON envelope, so there is no
            # parse step left to miss (`text_completion` exists for exactly
            # this). Chips are dropped: they are a nicety, the line is not.
            log.warning(
                "localized_reply_json_missed",
                request_id=ctx.request_id, error=str(exc),
            )
            line = await ctx.llm.text_completion(
                [
                    {"role": "system", "content": f"{sys}\n\n{_PLAIN_LINE_RULE}"},
                    {"role": "user", "content": usr},
                ],
                model=model,
                run_name="localized_reply_plain",
            )
            return LocalizedReply(line=line.strip(), chips=[])

    try:
        if ctx.kv_cache is not None:
            return await cached_llm_json(
                ctx.kv_cache, ns="localized_reply",
                key_parts={"s": situation, "lang": ctx.lang_code, "model": model},
                ttl_s=TTL_30D, schema=LocalizedReply, factory=_call,
            )
        return await _call()
    except Exception:  # noqa: BLE001 — never fail the turn on a phrasing miss
        log.exception("localized_reply_failed", request_id=ctx.request_id)
        return LocalizedReply(line="", chips=[])


# Worker prompt sections — every tool-calling worker uses the same
# subset. The "voice" sections (citations, response_shape, language,
# safety, followups) shape the FINAL prose — only the synthesizer
# writes that, so they're omitted here. `actions` carries the
# `[action:kind|id=…]` marker protocol — action_worker NEEDS it; the
# others tolerate it (~100 lines is the cost of keeping the worker
# prompt uniform).
WORKER_PROMPT_SECTIONS = ("header", "tools", "actions", "quoting")


async def owned_track_ids(ctx: TurnContext) -> list[str] | None:
    """The tracks THIS user added, for the private lecture lane (#1227).

    Resolved server-side from the verified JWT `sub` — NEVER from client-supplied
    recent_tracks. Best-effort: a failed lookup degrades to public-corpus-only
    rather than failing the turn.

    Shared because two lanes retrieve lectures and only one of them remembered
    to ask: the out-of-corpus fallback searched without this (and without the
    author scope), so a personal library was invisible in exactly the turn that
    announced the corpus had nothing.
    """
    if not ctx.user_id or ctx.chunk_repo is None:
        return None
    try:
        return await ctx.chunk_repo.get_owned_track_ids(ctx.user_id)
    except Exception as exc:  # noqa: BLE001 — private lane is best-effort
        log.warning("owned_track_ids_lookup_failed", error=str(exc))
        return None


def tool_schemas_from(tools: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull OpenAI-format schemas from the registered ToolDefs for the
    subset of tools this worker actually has bound."""
    from lectorium_chat.agent.tools._registry import all_tools

    defs = all_tools()
    out: list[dict[str, Any]] = []
    for name in tools:
        td = defs.get(name)
        if td is None:
            log.warning("worker_tool_no_schema", tool=name)
            continue
        out.append(
            {
                "type": "function",
                "function": {
                    "name": td.name,
                    "description": td.description,
                    "parameters": td.parameters,
                },
            }
        )
    return out


def anchor_block(state: ChatState) -> str:
    """Render USER CONTEXT ANCHORS — the bits chat_turn.py wrapper
    extracted from UserContext. Without them the LLM can't know to
    call chunks_get_window (needs a track_ref), can't compute date
    windows for user_tracks_list (needs `now`), and won't realise
    `user_history_search` has anything to search.

    Empty string when no anchors are present — keeps the prompt
    small for trivial turns.
    """
    focus_ref = state.get("focus_ref")
    focus_around_ms = state.get("focus_around_ms")
    current_track_ref = state.get("current_track_ref")
    now_iso = state.get("now_iso")
    history_summary = state.get("history_summary")
    if (
        focus_ref is None
        and current_track_ref is None
        and now_iso is None
        and not history_summary
    ):
        return ""
    lines = ["\n\nUSER CONTEXT ANCHORS"]
    if now_iso is not None:
        lines.append(
            f"- now={now_iso} — the device's current time. Use it to "
            f"compute `since` / `until` ISO-8601 bounds when the user "
            f"asks «вчера / на этой неделе / a week ago»."
        )
    if history_summary is not None:
        lines.append(
            f"- listening_history: {history_summary}. The user HAS listened "
            f"to lectures.\n"
            f"  * \"что я недавно слушал про X\" / \"I heard about X "
            f"recently\" → `user_history_search(query=\"X\")` — REQUIRED: "
            f"pass `query` extracted from the user's phrasing (the topic "
            f"after \"про\" / \"about\"). E.g. user says «что я слушал про "
            f"карму» → query=\"карма\".\n"
            f"  * \"что я слушал на этой неделе\" / \"вчера\" / \"за месяц\" → "
            f"`user_tracks_list(since=\"<iso>\", until=\"<iso>\")` — compute "
            f"both bounds from `now` above.\n"
            f"  NEVER use `chunks_search` for these — it ignores the user's "
            f"history."
        )
    if current_track_ref is not None:
        lines.append(
            f"- current_track_ref={current_track_ref} — the lecture the user "
            f"is currently listening to. Pass this as `track_ref` when the "
            f"query is about \"this lecture\" / \"эта лекция\"."
        )
    if focus_ref is not None and focus_around_ms is not None:
        lines.append(
            f"- focus_ref={focus_ref}, around_ms={focus_around_ms} — the "
            f"user just tapped this fragment. For \"this fragment\" / "
            f"\"расскажи подробнее\" / \"что было до этого\" → call "
            f"`chunks_get_window(track_ref={focus_ref}, around_ms="
            f"{focus_around_ms})`. For \"найди похожее на этот фрагмент\" → "
            f"`chunks_find_similar(track_ref={focus_ref})`."
        )
    return "\n".join(lines) + "\n"



async def run_worker(
    state: ChatState,
    runtime: Runtime[TurnContext],
    *,
    role: str,
    tools: dict[str, Any],
    status_key: str,
    include_anchors: bool = True,
    max_turns: int = DEFAULT_MAX_TURNS,
    extra_user_query: str | None = None,
) -> ResearchResult:
    """Generic worker body: status → ReAct loop → flush verses.

    Returns the raw `ResearchResult` so the caller can decide what
    to put in state["tool_results"] (research/catalog/help append;
    action_worker may merge with prior research results).

    `extra_user_query` overrides `state["user_query"]` when set — used
    by action_worker which runs AFTER research and wants to ask
    "now compose the action from the tracks above" instead of repeating
    the original user prompt.
    """
    bind_node_role(role)
    ctx = runtime.context

    prompt_prefix = anchor_block(state) if include_anchors else ""
    system_prompt = prompt_prefix + build_prompt(WORKER_PROMPT_SECTIONS, lang=state["lang"])
    schemas = tool_schemas_from(tools)

    writer = get_stream_writer()

    def _on_tool_event(event: str, tool_name: str) -> None:
        if event == "tool_start":
            writer({"type": "tool_start", "data": {"name": tool_name}})
        else:
            writer({"type": "tool_end", "data": {"name": tool_name}})

    def _yield_event(event_type: str, data: dict[str, Any]) -> None:
        """Bridge an emits_events tool's `yield_event(type, data)` call
        into a LangGraph custom-stream write so the SSE transport
        forwards it to the client. Without this hop the action_id the
        LLM gets back is never paired with an SSE `action` event, and
        the matching `[action:share_pdf|id=…]` marker in delta
        text renders as a broken card on mobile.

        Also records the action id of every real `action` event (the
        ones minted by track_pdf_generate / propose_* — they carry a
        hex `id`) so the MarkerExpander can drop any `[action:...|id=X]`
        marker whose id never actually fired. The verse / chapter /
        cite payload events also flow through `writer` but those use a
        synthetic string id (e.g. `verse_BG_2.13`) and aren't action
        markers, so we only capture ids from `propose_*`/pdf — keyed on
        the hex-`id` shape the marker grammar accepts.
        """
        if event_type == "action":
            action_id = data.get("id")
            if isinstance(action_id, str) and action_id:
                ctx.emitted_action_ids.add(action_id)
        writer({"type": event_type, "data": data})

    writer({"type": "status", "data": {"key": status_key}})

    # Build the Langfuse callback ONCE per worker invocation. Inside
    # the ReAct loop each iteration calls `stream_completion` with the
    # SAME callback list — Langfuse aggregates the multi-step LLM
    # interactions under the worker's span. None when observability is
    # disabled; the LLM adapter then skips the `callbacks` kwarg.
    cb = langfuse_node_callback(ctx.langfuse_trace_id, role) if ctx.langfuse_trace_id else None
    callbacks_list = [cb] if cb is not None else None

    result = await run_react_loop(
        extra_user_query or state["user_query"],
        extracted_args=state.get("extracted_args", {}),
        llm=ctx.llm,
        tools=tools,
        tool_schemas=schemas,
        aliases=ctx.aliases,
        system_prompt=system_prompt,
        request_id=ctx.request_id,
        max_turns=max_turns,
        on_tool_event=_on_tool_event,
        yield_event=_yield_event,
        callbacks=callbacks_list,
        run_name=role,
    )

    # Pre-translate inline-commentary purports (if opted in) concurrently
    # with the citation-payload flushes — the translation latency overlaps,
    # and the flush ordering invariant (action emitted BEFORE its marker) is
    # preserved because every flush completes before run_worker returns and
    # the synthesizer streams. Each flush itself may translate verse / cite /
    # media text; running them concurrently overlaps those calls too.
    await asyncio.gather(
        flush_card_payloads(ctx),
        translate_commentaries(ctx),
    )
    return result
