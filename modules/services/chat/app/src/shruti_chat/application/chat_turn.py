"""Application use-case: run one chat turn through the LangGraph chat graph.

This file used to drive `run_llm_loop` directly. Stage 1 of the
multi-agent migration replaces that with a compiled LangGraph
StateGraph (router → research_worker → synthesizer). The chat_turn
function owns the surrounding plumbing the graph doesn't:

- pre-mint `focus_ref` / `current_track_ref` so user-context ids
  never leak to the LLM as raw track ids
- build the `TurnContext` (per-turn services) the graph nodes pull
  from `runtime.context`
- bridge the graph's `astream` events into the existing `AgentEvent`
  SSE stream (so api/chat.py is unchanged)
- final terminal events: aliases map + done
- post-turn bypass-marker audit (catches the LLM typing
  `[cite:track_X@...]` directly instead of going through the
  numbered-ref protocol)

The external signature is unchanged so api/chat.py + run_proactive_turn
keep working.
"""

from __future__ import annotations

import asyncio
from time import perf_counter, time
from typing import Any, AsyncIterator, Awaitable, Callable
from uuid import uuid4

from shruti_chat.agent.aliased_tools import build_aliased_tools
from shruti_chat.agent.events import AgentEvent
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.markers import CARD_RE, CITE_RE, OUTLINE_RE
from shruti_chat.agent.tools import TOOLS, build_personalized_tools
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.application.author_scope import AuthorScope
from shruti_chat.application.chat_turn_request import ChatTurnRequest
from shruti_chat.composition import AppDeps
from shruti_chat.domain import UserContext
from shruti_chat.infra.llm_provider.openrouter import is_provider_unavailable
from shruti_chat.observability.auto_scores import (
    TurnSummary,
    audit_post_expansion_text,
    emit_turn_scores,
)
from shruti_chat.observability.langfuse_client import (
    get_langfuse,
    with_langfuse_trace,
)
from shruti_chat.observability.marker_annotations import annotate_markers
from shruti_chat.observability.logging import (
    bind_turn_context,
    clear_turn_context,
    get_logger,
)


log = get_logger(__name__)


# Per-worker tool subsets — one bag, sliced by name per graph node.
# Splitting cuts each worker's tool-menu to ~5-7 entries instead of
# 17, which improves tool-selection accuracy on weaker models.
_RESEARCH_TOOL_NAMES = frozenset({
    "chunks_search",
    "chunks_get_by_address",
    "chunks_get_window",
    "chunks_find_similar",
    "user_history_search",
    "track_outline_get",
})
# Locate is code-driven (run_locate); these tools are only the ReAct
# fallback toolset used when chunk_repo/embedder are absent (tests).
_LOCATE_TOOL_NAMES = frozenset({
    "chunks_search",
    "chunks_get_by_address",
})
_CATALOG_TOOL_NAMES = frozenset({
    "author_resolve",
    "source_resolve",
    "location_resolve",
    "tag_resolve",
    "tracks_list",
    "collections_find",
    "track_get",
    "user_tracks_list",
    # Needed so a deictic «перескажи последнюю лекцию» can be summarised
    # here: catalog resolves the last-played track via user_tracks_list,
    # then pulls its chapter outline to write the recap. Without this the
    # catalog worker can find the track but has no summary tool.
    "track_outline_get",
})
_ACTION_TOOL_NAMES = frozenset({
    "track_pdf_generate",
    "reminder_propose",
    "smart_library_propose",
    "pro_upgrade_propose",
    # Lets the action worker resolve a deictic «PDF последней лекции»
    # on its own: user_tracks_list(limit=1) → real track_ref →
    # track_pdf_generate. Needed because the action worker runs its OWN
    # ReAct loop and does NOT see this-turn candidates from a prior
    # worker — without a resolver here the deictic-PDF request had no
    # track to operate on and track_pdf_generate never got a real id.
    "user_tracks_list",
})
_HELP_TOOL_NAMES = frozenset({
    "help_get",
})


def _subset(
    tools: dict[str, Any], names: frozenset[str]
) -> dict[str, Any]:
    """Pick the named subset out of the full tool bag. Silently drop
    names that aren't bound (e.g. an action tool that didn't register
    because its dependency is unavailable) so partial deploys don't
    crash the graph at build time."""
    return {n: tools[n] for n in names if n in tools}


# Chip-class markers the LLM is FORBIDDEN to write directly — it must
# use the numbered-ref protocol (`[^N]`) and let the MarkerExpander
# expand those into the real track-id form before they hit the client.
# Anything matching the canonical expanded grammar (agent/markers.py) in
# the LLM-typed prose means the model bypassed the protocol — log the
# slip for prompt-engineering follow-up.


async def _audit_bypass_markers(
    llm_prose: str,
    *,
    deps: AppDeps | None,
    request_id: str | None,
) -> None:
    """Log every chip-class marker the LLM typed in prose. With the
    numbered-ref protocol active the correct path injects markers via
    `propose_*` tool side-events; anything in the LLM-prose buffer is
    an instruction-following slip we want visible in metrics."""
    findings: list[tuple[str, str]] = []
    for m in CITE_RE.finditer(llm_prose):
        findings.append(("cite", m.group(1)))
    for m in CARD_RE.finditer(llm_prose):
        findings.append(("card", m.group(1)))
    for m in OUTLINE_RE.finditer(llm_prose):
        findings.append(("outline", m.group(1)))
    if not findings:
        return

    valid: set[str] = set()
    if deps is not None:
        all_ids = list({tid for _, tid in findings})
        try:
            valid = set(await deps.catalog_repo.filter_existing_track_ids(all_ids))
        except Exception as exc:
            log.warning(
                "bypass_audit_validation_failed",
                request_id=request_id,
                error=str(exc),
            )
    for kind, tid in findings:
        log.info(
            "chat_marker_bypassed_tool",
            request_id=request_id,
            kind=kind,
            track_id=tid,
            in_catalog=tid in valid,
        )


async def run_chat_turn(
    request: ChatTurnRequest,
    *,
    deps: AppDeps,
    is_disconnected: Callable[[], Awaitable[bool]] | None = None,
) -> AsyncIterator[AgentEvent]:
    """Drive one chat turn through the LangGraph chat graph, yielding
    `AgentEvent`s. The graph internals are hidden behind the `astream` event
    bridge below.

    `request` is the turn's DATA (see `ChatTurnRequest`); `deps` and
    `is_disconnected` are its collaborators — the composition root's wiring and
    the caller's cancellation probe, neither of which belongs in a value object.
    """
    if deps is None or deps.chat_graph is None or deps.llm is None:
        raise RuntimeError(
            "run_chat_turn requires AppDeps with chat_graph + llm "
            "(lifespan must have built them)"
        )

    history = request.history
    lang = request.lang
    request_id = request.request_id
    user_context = request.user_context
    trace_id = request_id or "anon"
    # Langfuse-side trace ID. Prefer the client-supplied one so message
    # identity == trace identity for the feedback flow; otherwise fall
    # back to a fresh server-minted id. The same value is bound into
    # structlog so Grafana's Loki derived field
    # `langfuse_trace_id=([a-f0-9]+)` resolves to the right Langfuse URL.
    langfuse_trace_id = request.client_trace_id or uuid4().hex
    bind_turn_context(
        trace_id=trace_id,
        request_id=request_id,
        agent_role="main",
        langfuse_trace_id=langfuse_trace_id,
    )

    user_id_for_trace = user_context.user_id if user_context else None

    # End-of-turn metrics fed into emit_turn_scores in `finally`. Stay
    # local to the function so the bookkeeping has zero cost when
    # Langfuse is force-disabled (singleton None → emit_turn_scores no-ops).
    turn_started = perf_counter()
    first_token_at: float | None = None
    tool_calls_count = 0
    had_error = False
    # Whether the client got a tappable card. Read by the empty-turn backstop:
    # a card with no prose around it is still an answer. Tracked off the events
    # actually yielded rather than `emitted_action_ids`, which the workers
    # populate through a side channel.
    sent_action = False
    detected_intent: str | None = None
    full_prose: list[str] = []
    # Outline shape captured from synthesis_planner_node's one-shot
    # `outline_summary` custom event. Stays None on non-research flows
    # (action / help / catalog / direct chat) where no outline is built.
    outline_n_theses: int | None = None
    outline_has_intro: bool | None = None
    outline_has_conclusion: bool | None = None
    outline_skipped_notes_ratio: float | None = None
    # Conversation attributes as `router_node` settled them. Shipped on the
    # terminal `done` so the client persists them on the assistant message,
    # folds them into its aggregate, and replays both — the ride `aliases`
    # already takes.
    attributes: dict[str, Any] | None = None
    # Hoisted above the try so the `finally` teardown can always reference
    # it — even if turn setup raises before the task is created.
    embed_task: Any | None = None

    try:
        # ── Build per-turn services (aliases + expander + tools) ──────
        aliases = TurnAliasMap()
        # Pre-mint refs for `current_track_id` and `focus.track_id` so
        # the LLM sees integer refs throughout the turn, not raw ids.
        # Capture the minted integers — workers' system prompts surface
        # them as anchor metadata so the LLM can pass them straight into
        # chunks_get_window / chunks_find_similar.
        current_track_ref: int | None = None
        focus_ref: int | None = None
        focus_around_ms: int | None = None
        now_iso: str | None = None
        history_summary: str | None = None
        if user_context is not None:
            if user_context.current_track_id:
                current_track_ref = aliases.alias_track(user_context.current_track_id)
            if user_context.focus is not None:
                focus_ref = aliases.alias_chunk(
                    user_context.focus.track_id,
                    int(user_context.focus.start_ms),
                    int(user_context.focus.end_ms),
                )
                focus_around_ms = (
                    int(user_context.focus.start_ms) + int(user_context.focus.end_ms)
                ) // 2
            if user_context.now is not None:
                now_iso = user_context.now.isoformat()
            if user_context.recent_tracks:
                in_prog = len(user_context.in_progress_tracks())
                history_summary = (
                    f"recent={len(user_context.recent_tracks)} "
                    f"in_progress={in_prog}"
                )

        # Per-worker tool subsets — each graph node gets a narrow toolset
        # so the LLM picks from a smaller menu and tool-selection
        # accuracy goes up. The full bag is aliased once; we then slice
        # by name per worker (the aliasing is idempotent and the shared
        # alias map keeps refs consistent across workers in the same
        # turn).
        all_tools = build_personalized_tools(TOOLS, user_context)
        aliased_tools = build_aliased_tools(all_tools, aliases)
        research_tools = _subset(aliased_tools, _RESEARCH_TOOL_NAMES)
        locate_tools = _subset(aliased_tools, _LOCATE_TOOL_NAMES)
        catalog_tools = _subset(aliased_tools, _CATALOG_TOOL_NAMES)
        action_tools = _subset(aliased_tools, _ACTION_TOOL_NAMES)
        help_tools = _subset(aliased_tools, _HELP_TOOL_NAMES)

        # Shared by reference between the expander and the TurnContext:
        # workers' `_yield_event` records every emitted action id here,
        # and the expander reads it to drop hallucinated (never-emitted)
        # `[action:...|id=X]` markers before they reach the client.
        emitted_action_ids: set[str] = set()
        caps = request.capabilities or {}
        expander = MarkerExpander(
            aliases,
            request_id=request_id,
            emitted_action_ids=emitted_action_ids,
            # When the client can render commentary cards, the expander
            # emits a `[commentary:…]` marker (paired with an action
            # payload) instead of inlining a markdown blockquote.
            commentary_as_card=bool(caps.get("commentary_card")),
            # Card-capable clients get ALL auto-render cards (verse / cite /
            # media / chapter) emitted lazily at synth time, cited-only — so
            # citation translation runs only on what the answer shows, never
            # the whole candidate pool. Driven by the CARD_SPECS registry.
            lazy_cards=bool(caps.get("commentary_card")),
        )

        # Speculative embed: most non-trivial intents (research,
        # find_track) need the user-query embedding eventually. Start it
        # in parallel with the router LLM call so we don't pay both
        # latencies sequentially. The router node cancels this task when
        # the intent ends up being direct_chat / help / create_action
        # (those don't need the embedding). On hit we shave 150-300 ms
        # off every research turn — the embed_query was previously the
        # first step inside research/pipeline, blocking the rest.
        user_query_text = request.latest_user_query()
        if user_query_text and deps.embedder is not None:
            embed_task = asyncio.create_task(
                deps.embedder.embed_query(user_query_text),
                name="speculative_embed_query",
            )

        # Empty until the router settles the turn's attributes; the tools close
        # over this very object, so filling it there is what makes the selection
        # reach them.
        author_scope = AuthorScope(
            catalog_repo=deps.catalog_repo, request_id=trace_id,
        )

        ctx = TurnContext(
            request_id=trace_id,
            lang=lang,
            translate_citations=request.translate_citations,
            capabilities=caps,
            # `getattr` tolerates test doubles that predate this field.
            translator=getattr(deps, "translation_service", None),
            region=request.region,
            langfuse_trace_id=langfuse_trace_id,
            aliases=aliases,
            expander=expander,
            emitted_action_ids=emitted_action_ids,
            llm=deps.llm,
            research_tools=research_tools,
            locate_tools=locate_tools,
            catalog_tools=catalog_tools,
            action_tools=action_tools,
            help_tools=help_tools,
            library_db_path=deps.settings.library_db_path,
            # Code-driven research pipeline collaborators.
            chunk_repo=deps.chunk_repo,
            catalog_repo=deps.catalog_repo,
            user_context=user_context,
            embedder=deps.embedder,
            reranker=deps.reranker,
            pool=deps.pool,
            embed_model=deps.settings.embed_model,
            embed_dim=deps.settings.embed_dim,
            kv_cache=deps.kv_cache,
            embed_task=embed_task,
            author_scope=author_scope,
            # Add-to-library (#1226): identity for the ingest.request payload,
            # plus the provider resolver from the deps. `getattr` tolerates test
            # AppDeps doubles that predate the field.
            user_id=(user_context.user_id if user_context else None),
            jwt=request.jwt,
            lecture_search=getattr(deps, "lecture_search", None),
        )

        # A stale Pro claim (auth minted tier="pro" but tier_expires_at is in
        # the past — e.g. a dropped EXPIRATION webhook) must NOT unlock
        # Pro-only capabilities like add-to-library. Coerce it back to free
        # BEFORE the tier reaches any graph gate, mirroring the rate limiter
        # (`application/rate_limiter._user_limit_for`).
        effective_tier = request.effective_tier(int(time()))

        initial_state: dict[str, Any] = {
            "history": history,
            "user_query": request.latest_user_query(),
            "lang": lang,
            "client_attributes": request.client_attributes or {},
            "request_id": trace_id,
            "tier": effective_tier,
            "tool_results": [],
            "focus_ref": focus_ref,
            "focus_around_ms": focus_around_ms,
            "current_track_ref": current_track_ref,
            "now_iso": now_iso,
            "history_summary": history_summary,
            "config": request.turn_config or {},
        }

        # ── Drive the graph; bridge custom events to AgentEvents ─────
        #
        # The Langfuse trace stays open across the whole graph
        # invocation so every node-level CallbackHandler created via
        # `langfuse_node_callback(langfuse_trace_id, ...)` attaches its
        # spans under the same root. No-op when the SDK is uninitialised
        # (LANGFUSE_FORCE_FALLBACK=1 or missing env).
        user_query_for_trace = request.latest_user_query()
        async with with_langfuse_trace(
            langfuse_trace_id,
            user_id_for_trace,
            session_id=request.session_id,
            session_title=request.session_title,
            name="chat_turn",
            input=user_query_for_trace or None,
            region=request.region,
        ) as langfuse_root_span:
            try:
                async for mode, payload in deps.chat_graph.astream(
                    initial_state,
                    context=ctx,
                    stream_mode=["custom"],
                ):
                    if mode != "custom":
                        continue
                    # All node-writer emissions have shape {type, data}.
                    ev_type = payload.get("type")
                    ev_data = payload.get("data", {})
                    if not ev_type:
                        continue
                    if ev_type == "delta":
                        full_prose.append(ev_data.get("text", ""))
                        if first_token_at is None:
                            first_token_at = perf_counter()
                    elif ev_type == "tool_start":
                        tool_calls_count += 1
                    elif ev_type == "status":
                        # Router decision arrives as `status` with
                        # `key=router_decision` and `params.intent=…`
                        # — only on the main chat path, not proactive.
                        # Captured purely for the `router_intent` score.
                        if ev_data.get("key") == "router_decision":
                            params = ev_data.get("params") or {}
                            maybe = params.get("intent")
                            if isinstance(maybe, str):
                                detected_intent = maybe
                    elif ev_type == "action":
                        sent_action = True
                    elif ev_type == "error":
                        had_error = True
                    elif ev_type == "attributes":
                        # Not a client-facing event — it leaves on `done`.
                        attributes = ev_data or None
                        continue
                    elif ev_type == "outline_summary":
                        # synthesis_planner_node emits this once per turn
                        # for Langfuse scoring. NOT a client-facing event
                        # — swallow it rather than yielding to the SSE.
                        outline_n_theses = ev_data.get("n_theses")
                        outline_has_intro = ev_data.get("has_intro")
                        outline_has_conclusion = ev_data.get("has_conclusion")
                        outline_skipped_notes_ratio = ev_data.get(
                            "skipped_notes_ratio",
                        )
                        continue
                    yield AgentEvent(type=ev_type, data=ev_data)
                    # Co-op cancellation if the client closed the SSE.
                    if is_disconnected is not None and await is_disconnected():
                        log.info(
                            "chat_cancelled_mid_stream",
                            request_id=request_id,
                            prose_chars=sum(len(s) for s in full_prose),
                        )
                        # Tag the Langfuse trace so corpus evals can
                        # exclude cancelled turns from quality metrics
                        # (and so debugging can tell a "user gave up"
                        # signal apart from a model failure). Trace-
                        # level tag + metadata mirror so both surface in
                        # the Langfuse UI filter dropdowns.
                        lf = get_langfuse()
                        if lf is not None:
                            try:
                                lf.update_current_trace(
                                    tags=["cancelled_by_client"],
                                    metadata={"cancelled_by_client": True},
                                )
                            except Exception as exc:  # noqa: BLE001
                                log.warning(
                                    "langfuse_cancel_tag_failed",
                                    request_id=request_id,
                                    error=str(exc),
                                )
                        # Returning here runs the `finally`, which cancels
                        # the speculative embed task — no need to repeat it.
                        return
            except Exception as exc:
                log.exception("chat_graph_failed", request_id=request_id, error=str(exc))
                had_error = True
                # An out-of-credits / provider-down failure is not a graph
                # bug — surface it as a calm "chat unavailable" so the
                # client shows "try again later", not a generic error.
                code = "chat_unavailable" if is_provider_unavailable(exc) else "agent_error"
                yield AgentEvent(
                    type="error",
                    data={"code": code, "message": str(exc)},
                )
                return

            # The expander is fed and flushed entirely inside the
            # synthesizer node (the only node that streams prose through
            # it — see synthesizer_turn). It has already emitted its tail
            # by the time the graph stream completes, so there is no
            # second flush to do here.

            # ── Record final answer on the Langfuse trace ────────────────
            # Write to BOTH the root span (latency / span output pane) AND
            # the trace itself (Trace row + Sessions tab). Trace-level
            # write goes through `update_current_trace` because span
            # output does NOT mirror to trace I/O reliably once nested
            # generations have already touched trace attributes
            # (langfuse issue #9556).
            if langfuse_root_span is not None and full_prose:
                final_output = "".join(full_prose)
                # Inline a human-readable expansion under each chip marker
                # so a reviewer can see WHICH lecture / purport was cited
                # and judge its relevance — the raw `[cite:track@…]` /
                # `[commentary:N]` markers are opaque in the trace. Trace
                # copy only; the client already got the unannotated stream.
                # Pure + dependency-free, but guarded so it can never break
                # the actual output write below.
                try:
                    final_output = annotate_markers(final_output, aliases)
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "langfuse_marker_annotation_failed",
                        request_id=request_id,
                        error=str(exc),
                    )
                try:
                    langfuse_root_span.update(output=final_output)
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "langfuse_span_output_failed",
                        request_id=request_id,
                        error=str(exc),
                    )
                try:
                    lf = get_langfuse()
                    if lf is not None:
                        lf.update_current_trace(output=final_output)
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "langfuse_trace_output_failed",
                        request_id=request_id,
                        error=str(exc),
                    )

        # ── Bypass-marker audit (off the hot path) ───────────────────
        # Logs structlog `chat_marker_bypassed_tool` events — kept as-is
        # for the Loki/Grafana dashboards built on top of it. The same
        # bypass count also lands in Langfuse via auto-scores below.
        joined_prose = "".join(full_prose)
        await _audit_bypass_markers(joined_prose, deps=deps, request_id=request_id)

        # ── Heuristic auto-scores on the Langfuse trace ──────────────
        # Wrapped in its own try/except because none of these signals
        # should be allowed to break the `done` terminator below.
        try:
            audit = await audit_post_expansion_text(
                joined_prose,
                llm_raw_prose=joined_prose,
                malformed_dropped_count=expander.malformed_count,
                catalog_repo=deps.catalog_repo if deps else None,
                library_db_path=deps.settings.library_db_path if deps else None,
            )
            total_ms = int((perf_counter() - turn_started) * 1000)
            first_token_ms: int | None = None
            if first_token_at is not None:
                first_token_ms = int((first_token_at - turn_started) * 1000)
            summary = TurnSummary(
                request_lang=lang,
                latency_total_ms=total_ms,
                first_token_ms=first_token_ms,
                tool_calls_count=tool_calls_count,
                response_length_chars=len(joined_prose),
                had_error=had_error,
                intent=detected_intent,
                final_text=joined_prose,
                outline_n_theses=outline_n_theses,
                outline_has_intro=outline_has_intro,
                outline_has_conclusion=outline_has_conclusion,
                outline_skipped_notes_ratio=outline_skipped_notes_ratio,
            )
            emit_turn_scores(get_langfuse(), langfuse_trace_id, summary, audit)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "auto_scores_failed",
                request_id=request_id,
                error=str(exc),
            )

        # ── No turn may end with a blank bubble ──────────────────────
        # Every cause converges here, so this is the one place that can tell.
        # Three production turns in two weeks ended with the user staring at
        # nothing: `localized_reply` missing parseable JSON on BOTH models, a
        # 429 with no fallback left, and a pipeline that stopped after
        # `topic_extractor` with no synthesizer observation AND no error. The
        # first two are fixed at their source; this backstop covers the third
        # and whatever comes next. `agent_error` is already localised on every
        # client and already triggers the quota refund — an answer that never
        # arrived must not be charged for.
        #
        # An action-only turn is NOT empty: the user got a tappable card even
        # with no prose around it.
        if not had_error and not sent_action and not any(s.strip() for s in full_prose):
            log.warning(
                "chat_turn_produced_no_output",
                request_id=request_id,
                intent=detected_intent,
            )
            yield AgentEvent(
                type="error",
                data={"code": "agent_error", "message": "empty answer"},
            )
            return

        # ── Terminal `done` carries the alias map inline ─────────────
        # v1 protocol: client persists `done.data.aliases` on the
        # freshly-finalised assistant message and ships it back on the
        # next turn so `_fold_prior_assistant_content` rewrites chip
        # markers in history into `[^N]` form.
        done_data: dict[str, Any] = {}
        if len(aliases) > 0:
            done_data["aliases"] = aliases.serialize()
        if attributes:
            done_data["attributes"] = attributes
        yield AgentEvent(type="done", data=done_data)

    finally:
        # Authoritative teardown for the speculative embed. The router
        # cancels it early for intents that don't consume the embedding,
        # and the disconnect path cancels it mid-stream — but neither
        # fires on a normally-completing find_track / unknown turn (those
        # route to catalog_worker / synthesizer, which never await it).
        # Without this backstop the orphaned task lingers until GC,
        # holding an embedding-API connection slot and, if it raised,
        # surfacing as "Task exception was never retrieved".
        if embed_task is not None and not embed_task.done():
            embed_task.cancel()
        clear_turn_context()
