"""Find-tracks worker — DETERMINISTIC lecture search (intent=find_tracks).

The user asks to FIND lectures about a topic ("find a lecture on purifying
the heart"). Unlike `research` (which synthesizes an essay), this returns the
LECTURES THEMSELVES as a ranked list of cards, each with a short description
and a verbatim transcript quote showing why it matched.

Everything happens in this node, which terminates at END (no synthesizer):

1. Embed the query and semantic-search transcript chunks, constrained by the
   metadata filters the router extracted (source / year / author / location).
   Group by track, rank lectures by their best chunk score, DROP anything
   below the relevance floor, and quote the best NON-intro chunk (the lecture
   opening is boilerplate, not a reason). Progressive relaxation drops the
   narrowest filter on an empty hit.
2. Resolve each lecture's catalog display (title / author / date / refs) and
   its description — concurrently. A lecture the published catalog doesn't
   carry is dropped (the client couldn't render its card anyway).
3. The ONLY LLM hop: per lecture a short DESCRIPTION blending the lecture's
   own catalog description with the user's question, plus one global intro —
   all run concurrently. The model writes prose only; it never sees a
   track_id or an array, so there is nothing for it to mis-order.
4. Emit straight to the client (bypassing the synthesizer like
   `action_responder`): the global intro, then per lecture a description
   paragraph, a `[card:track]` tile and a `[cite:…]` quote. Each card and
   quote ships a server-resolved `action` payload FIRST (so thin clients with
   no local catalog — web — can render), honouring action-before-marker.
"""

from __future__ import annotations

import asyncio

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.agent.graph.nodes._worker_common import resolve_track_display
from shruti_chat.agent.graph.nodes.find_tracks_cards import emit_lecture_cards
from shruti_chat.agent.graph.nodes.find_tracks_filters import (
    REF_RUNG,
    build_filters,
    resolve_named_author,
    resolve_source,
    was_relaxed,
)
from shruti_chat.agent.graph.nodes.find_tracks_probes import (
    probe_and_answer_date,
    probe_and_answer_ref,
)
from shruti_chat.agent.graph.nodes.find_tracks_prose import (
    describe_lecture,
    emit_empty,
    other_language_note,
    write_intro,
)
from shruti_chat.agent.graph.nodes.find_tracks_search import find_lectures
from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.observability.logging import bind_node_role, get_logger

log = get_logger(__name__)


async def find_tracks_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("find_tracks_worker")
    ctx = runtime.context
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "searching_corpus"}})

    query = (state.get("user_query") or "").strip()
    args = state.get("extracted_args") or {}

    if ctx.embedder is None or ctx.chunk_repo is None or ctx.catalog_repo is None or not query:
        log.warning("find_tracks_missing_deps", request_id=ctx.request_id)
        return await emit_empty(ctx, writer, query)

    # The user named a teacher. Resolve them ONCE — the same resolution decides
    # whether the corpus has them at all AND which author_id constrains the
    # search, so the guard and the filter cannot disagree. A name that is only
    # honorifics ("Свами") denotes nobody in particular: no guard, no filter.
    author_id: str | None = None
    requested_author = args.get("author")
    if isinstance(requested_author, str) and ctx.name_matcher.distinctive_tokens(
        requested_author,
    ):
        hit = await resolve_named_author(ctx, requested_author)
        if hit is None:
            # The corpus does NOT have this teacher. Guard here so the unresolved
            # author can't drop out of the filter and let the semantic search
            # return SOME OTHER teacher's lectures (which synth would then
            # misattribute). Route to add-to-library web discovery instead.
            if not ctx.capabilities.get("personal_library"):
                return await emit_empty(ctx, writer, query)
            log.info(
                "find_tracks_unknown_author_web_fallback",
                request_id=ctx.request_id,
                author=requested_author.strip()[:60],
            )
            return {"web_fallback": True}
        author_id = hit.id

    embedding = await ctx.embedder.embed_query(query)
    full = await build_filters(ctx, args, author_id=author_id)

    # The router extracts `topic` when the request is ABOUT something; a bare
    # metadata request («утренние прогулки 1976 Бомбей») carries none.
    topical = bool(str(args.get("topic") or "").strip())
    # A book the catalog never heard of: no filter was built from it (the router
    # set it aside), so the only thing left to do is admit it.
    unknown_source = str(args.get("unknown_source") or "").strip()
    found = await find_lectures(ctx, embedding, full, topical=topical)
    lectures, relaxed = found.lectures, found.relaxed
    lang_note = ""
    if lectures and found.other_language:
        # The lecture exists, just not with a transcript in the language of the
        # conversation. Hiding it reads as "the corpus doesn't have it", so we
        # serve it and say which language it is in.
        lang_note = await other_language_note(
            ctx, [sc.chunk.lang for sc in lectures],
        )
        log.info(
            "find_tracks_other_language",
            request_id=ctx.request_id,
            requested_lang=ctx.lang_code,
            found_langs=sorted({sc.chunk.lang for sc in lectures}),
        )

    if not lectures:
        # Semantic search found nothing — but for a BARE scripture reference
        # that's the wrong tool: "sb 1.2.6-1.2.18" embeds to noise, so a real
        # match scores below the floor. The catalog maps lectures→verses
        # directly (track_references), so probe that index deterministically
        # before giving up. Most bare refs DO have lectures the embedding
        # missed — serve them. Only when the ref-index is ALSO empty do we ask
        # whether the user wanted the verses themselves.
        source_id = args.get("source_id")
        tokens = args.get("tokens")
        if source_id and tokens:
            return await probe_and_answer_ref(
                ctx, writer, str(source_id), str(tokens), author_id=author_id,
            )
        # A date-only query ("лекции, прочитанные 9 июля") is also invisible to
        # semantic search (no topic to embed). The catalog stores a per-track
        # date, so probe it directly by year range and/or "on this day" (MM-DD
        # across all years — the anniversary the user usually means).
        date_from = args.get("date_from")
        date_to = args.get("date_to")
        anniversary = args.get("anniversary_md")
        if date_from or date_to or anniversary:
            return await probe_and_answer_date(
                ctx, writer, date_from, date_to, anniversary, author_id=author_id,
            )
        # No lecture in the corpus (not a bare scripture ref / date probe):
        # route to add-to-library web discovery, read by route_after_find_tracks.
        if not ctx.capabilities.get("personal_library"):
            return await emit_empty(ctx, writer, query, unknown_source=unknown_source)
        log.info("find_tracks_empty_web_fallback", request_id=ctx.request_id, query=query[:80])
        return {"web_fallback": True}

    track_ids = [sc.chunk.track_id for sc in lectures]
    # Server-resolved display (title/author/date/refs) for thin clients, and
    # the per-track description — concurrently. A track the published catalog
    # doesn't carry has no display title → drop it (client can't render it).
    displays, outlines = await asyncio.gather(
        asyncio.gather(*(resolve_track_display(ctx, tid) for tid in track_ids)),
        asyncio.gather(*(ctx.catalog_repo.get_outline(tid, ctx.lang_code) for tid in track_ids)),
    )
    kept = [
        (sc, disp, (outline[1] or ""))
        for sc, disp, outline in zip(lectures, displays, outlines)
        if disp.get("track_title")
    ]
    if not kept:
        log.info("find_tracks_all_uncatalogued", request_id=ctx.request_id)
        return await emit_empty(ctx, writer, query)

    # The only LLM hop — per-lecture descriptions + the global intro, all
    # concurrent. Each call sees ONE lecture; wall-clock ≈ one call.
    desc_tasks = [
        describe_lecture(ctx, query, disp.get("track_title", ""), description, sc.chunk.text)
        for sc, disp, description in kept
    ]
    # When the reference filter had to be dropped, the lead-in gets the human
    # address it must NOT claim («БГ 10»). Costs a catalog lookup only on that
    # miss path.
    dropped_source = ""
    if was_relaxed(relaxed, "source") and args.get("source_id"):
        _, short = await resolve_source(ctx, str(args.get("source_id")))
        dropped_source = short or ""
    ref_label = ""
    if was_relaxed(relaxed, REF_RUNG):
        _, short = await resolve_source(ctx, str(args.get("source_id") or ""))
        tokens = str(args.get("tokens") or "").strip()
        ref_label = f"{short} {tokens}".strip() if short else tokens
    intro_task = write_intro(
        ctx, query, len(kept), relaxed, lang_note=lang_note, ref=ref_label,
        partial=found.partial, unknown_source=unknown_source,
        dropped_source=dropped_source,
    )
    prose = await asyncio.gather(intro_task, *desc_tasks)
    intro, descriptions = prose[0], list(prose[1:])

    writer({"type": "status", "data": {"key": "composing_answer"}})
    if intro:
        writer({"type": "delta", "data": {"text": intro + "\n\n"}})

    await emit_lecture_cards(ctx, writer, kept, descriptions)

    log.info(
        "find_tracks_ok",
        request_id=ctx.request_id,
        n_lectures=len(kept),
        relaxed=relaxed,
    )
    return {}
