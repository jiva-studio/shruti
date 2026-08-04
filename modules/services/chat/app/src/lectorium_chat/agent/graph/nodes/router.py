"""Router node — calls `application/router_turn.py` and writes the
result into ChatState.

Thin adapter: 8 lines of real logic. The LLM-prompt and intent classifier
live in the use-case; this node just bridges state ↔ runtime.context.

It also settles this turn's CONVERSATION ATTRIBUTES — the reply language and the
lecturers the answer may draw on. Here, because this is the one node every path passes through before
any prose is composed, and because `ctx` is mutable: writing the resolved locale
to both `state["lang"]` and `ctx.lang` leaves every downstream hop reading ONE
value. That single value is the point — the hops draw the language from
different places (the synthesizer from `state` plus the history, `localized_reply`
and the card blurbs from `ctx.lang` in code), so any of them deciding for itself
means an answer whose body and summary paragraph disagree.

Merging and carrying attributes is generic; APPLYING one is not. The language
becomes `ctx.lang` here in two explicit lines, and the next attribute will go
somewhere else entirely — a dispatch table over one member would be machinery,
not clarity.
"""

from __future__ import annotations

import asyncio

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.classify import (
    AddressClassifier,
    LectureUrlClassifier,
    run_classifier_chain,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.prior_refs import extract_prior_track_refs
from lectorium_chat.application.followup_rewrite import resolve_followup_query
from lectorium_chat.application.conversation_attributes import (
    detect_attributes,
    remembered_attributes,
)
from lectorium_chat.application.router_turn import run_router_turn
from lectorium_chat.domain.author_selection import AuthorSelection
from lectorium_chat.domain.conversation_attributes import (
    REPLY_LANGUAGE,
    Attribute,
    merge_attributes,
)
from lectorium_chat.domain.routing import RoutingDecision
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.observability.langfuse_client import langfuse_node_callback
from lectorium_chat.observability.logging import bind_node_role, get_logger


log = get_logger(__name__)


# Deterministic classifiers tried before the LLM router. Stateless — built
# once. Each claims a query (high precision) or passes; on a pass we fall
# through to the LLM router below. The LLM is the LAST link in the chain.
_DETERMINISTIC_CHAIN = [AddressClassifier(), LectureUrlClassifier()]


def _start_attributes(
    state: ChatState, ctx: TurnContext,
) -> "asyncio.Task[dict[str, Attribute]] | None":
    """Kick off attribute detection so it overlaps the router's own LLM call.

    Runs on the message the user actually typed, NOT the follow-up rewrite —
    the rewrite is written by another model and would launder the language.

    Not awaited in a `finally`: `detect_attributes` swallows its own failures
    (it can only return fewer attributes), so the only way past the await below
    is a node exception that ends the turn regardless.
    """
    query = state.get("user_query") or ""
    if ctx.llm is None or not query.strip():
        return None
    cb = (
        langfuse_node_callback(ctx.langfuse_trace_id, "attributes")
        if ctx.langfuse_trace_id
        else None
    )
    return asyncio.create_task(
        detect_attributes(
            query,
            llm=ctx.llm,
            request_id=ctx.request_id,
            kv_cache=ctx.kv_cache,
            callbacks=[cb] if cb is not None else None,
            catalog_repo=ctx.catalog_repo,
        ),
        name="conversation_attributes",
    )


async def _settle_attributes(
    state: ChatState,
    ctx: TurnContext,
    task: "asyncio.Task[dict[str, Attribute]] | None",
) -> dict[str, Attribute]:
    """Fold this message's readings into what the dialogue already knew, then
    apply the ones this turn acts on: the reply language and the lecturers the
    answer may be built from.

    The reply language is published to BOTH places the downstream hops read:
    `ctx.lang` (code-composed prose — `localized_reply`, card blurbs) and
    `state["lang"]` (the prompt directive) via the caller's state update. An
    empty result means nothing was ever derived — the client's locale stays in
    force and nothing is stored, so changing the app's language later still
    takes effect.
    """
    detected = await task if task is not None else {}
    settled = merge_attributes(
        detected=detected,
        remembered=remembered_attributes(
            state.get("history"), state.get("client_attributes"),
        ),
    )
    language = settled.get(REPLY_LANGUAGE)
    if language is not None:
        ctx.lang = language.single()
        ctx.lang_name = language.label
    # The chosen lecturers reach retrieval the same way: through the scope every
    # lane holds by reference. Unconditional, because "nobody was chosen" is a
    # value too — it is how a filter gets LIFTED, and skipping the call would
    # leave the previous turn's narrowing in force.
    if ctx.author_scope is not None:
        ctx.author_scope.apply(AuthorSelection.from_attributes(settled))
    return settled


async def router_node(state: ChatState, runtime: Runtime[TurnContext]) -> dict:
    bind_node_role("router")
    ctx = runtime.context
    get_stream_writer()({"type": "status", "data": {"key": "thinking"}})

    # 1. Deterministic chain on the RAW query first. A bare scripture reference
    #    ("БГ 2.13", "Мадхья лила 17.80") is resolved here without the LLM —
    #    the LLM router lossily collapses such refs (drops the CC lila), so
    #    reading the raw query is both cheaper and more correct. Running it
    #    BEFORE the follow-up rewrite also protects the show_verse fast path:
    #    the rewriter tends to dress «БГ 2.13» up as «Что говорится в БГ 2.13?»,
    #    which is no longer a bare address.
    query = state["user_query"]
    decision = await run_classifier_chain(_DETERMINISTIC_CHAIN, query, ctx)

    # 1a. Read this message's conversation attributes, in parallel with the
    #     router's LLM call. Skipped when the deterministic chain already
    #     claimed the query: that means a bare scripture address or a URL,
    #     which carries no signal to read — exactly the abstain case.
    lang_task = _start_attributes(state, ctx) if decision is None else None

    # 2. Fall-through (no deterministic hit). Resolve a context-dependent
    #    follow-up into a self-contained query BEFORE the LLM router. The
    #    router + retrieval read the current message alone, so «А ещё?» after
    #    an asura answer would route to direct_chat and answer ungrounded;
    #    rewriting it to «Ещё стихи БГ о природе асуров» lets the rest of the
    #    pipeline work on a real query. Gated (history + short message) so
    #    normal turns pay no extra call. Re-run the chain on the rewrite so a
    #    follow-up that resolves to a bare ref ("а ещё БГ 2.13?") still takes
    #    the show_verse fast path.
    if decision is None:
        rewritten = await resolve_followup_query(
            state.get("history"),
            state["user_query"],
            llm=ctx.llm,
            request_id=ctx.request_id,
        )
        if rewritten != query:
            query = rewritten
            decision = await run_classifier_chain(_DETERMINISTIC_CHAIN, query, ctx)

    # 3. LLM router fallback (the last chain link) for everything else.
    if decision is None:
        cb = langfuse_node_callback(ctx.langfuse_trace_id, "router") if ctx.langfuse_trace_id else None
        # Minimal conversation-context signal: did the prior assistant turn
        # surface track refs the user can point at? Disambiguates deictic
        # follow-ups and keys the router cache so they don't collide.
        prior_turn_had_refs = bool(extract_prior_track_refs(state.get("history")))
        # Player-context signals so the classifier sets deictic flags
        # consistently with reality (don't flag current_ref with nothing open,
        # or recent_ref/history_ref with no listen-log). Both are already in
        # state: current_track_ref (minted from user_context.current_track_id)
        # and history_summary (from user_context.recent_tracks).
        has_current_track = bool(state.get("current_track_ref"))
        has_recent_history = bool(state.get("history_summary"))
        # A genuine parse failure (structured-output retries + fallback model
        # + JSON salvage all exhausted) raises out of run_router_turn. The
        # domain design says `unknown` is the intended soft fallback — a failed
        # classification must NOT kill the whole turn. Catch and degrade so the
        # turn proceeds down the documented synthesizer path.
        try:
            decision = await run_router_turn(
                query,
                lang=state["lang"],
                llm=ctx.llm,
                request_id=ctx.request_id,
                prior_turn_had_refs=prior_turn_had_refs,
                has_current_track=has_current_track,
                has_recent_history=has_recent_history,
                kv_cache=ctx.kv_cache,
                callbacks=[cb] if cb is not None else None,
            )
        except Exception:
            log.exception(
                "router_turn_failed_soft_fallback_unknown",
                request_id=ctx.request_id,
            )
            decision = RoutingDecision(
                intent="unknown", confidence=0.0, extracted_args={},
            )
    # Cancel the speculative embed task for intents that don't consume
    # the embedding. Saves one OpenRouter call per direct_chat / help /
    # create_action turn; on research / find_track / unknown we leave
    # it running so the worker can await its result.
    if ctx.embed_task is not None and decision.intent not in {
        "research",
        "find_track",
        "unknown",
    }:
        ctx.embed_task.cancel()
        ctx.embed_task = None
    # Surface the routing decision as an SSE `status` event. The API layer
    # (`api/chat.py`) and the Langfuse `router_intent` score both look for a
    # `status` event with key=router_decision / params.intent — without this
    # emit the help-quota refund path is dead code and the intent is never
    # observable. Emitted for every path (deterministic, follow-up, LLM).
    get_stream_writer()(
        {"type": "status", "data": {"key": "router_decision", "params": {"intent": decision.intent}}}
    )
    update: dict = {
        "intent": decision.intent,
        "confidence": decision.confidence,
        "extracted_args": decision.extracted_args,
        # Persist the resolved query so the worker + synthesizer retrieve and
        # answer the self-contained form, not the bare follow-up.
        "user_query": query,
    }
    attributes = await _settle_attributes(state, ctx, lang_task)
    language = attributes.get(REPLY_LANGUAGE)
    if language is not None:
        update["lang"] = language.single()
    if attributes:
        # Not a client-facing event: `chat_turn` swallows it and puts the map on
        # the terminal `done`, which is where the client already picks up
        # per-message server state (`aliases`). The WHOLE map goes out, not just
        # what changed this turn, so the client's aggregate is a replace rather
        # than a merge it could get wrong.
        get_stream_writer()({
            "type": "attributes",
            "data": {k: a.model_dump() for k, a in attributes.items()},
        })
    return update
