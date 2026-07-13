"""Find-tracks worker — DETERMINISTIC lecture search (intent=find_tracks).

The user asks to FIND lectures about a topic ("найди лекцию про очищение
сердца"). Unlike `research` (which synthesizes an essay), this returns the
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
from collections import defaultdict

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime
from pydantic import BaseModel

from lectorium_chat.agent.graph.nodes._worker_common import (
    LocalizedReply,
    build_cite_payload,
    localized_reply,
    resolve_track_display,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.config import get_settings
from lectorium_chat.domain.entities import Message, ScoredChunk
from lectorium_chat.infra.repositories._ref_filter import parse_tokens
from lectorium_chat.observability.logging import bind_node_role, get_logger

log = get_logger(__name__)

# At most five lecture cards — the user scans a short, scannable list and adds
# one to a playlist; beyond that it stops being useful.
_MAX_LECTURES = 5
# Pull well over `_MAX_LECTURES` chunks so grouping-by-track still yields a
# full list AND leaves a non-intro chunk to quote per track.
_SEARCH_TOP_K = 24
# Cosine floor — below this the lecture isn't really "about" the query; we'd
# rather show fewer cards than an off-topic one. Matches chunks_search.
_MIN_SCORE = 0.45
# Chunks starting in the first minute are the lecture's standard opening
# ("Лекция по ШБ … итак, зачитайте"). Never quote those when a real passage
# exists.
_INTRO_MS = 60_000


class _Prose(BaseModel):
    """A single prose string — the only thing the model produces this turn."""

    text: str


def _year_range(year: object) -> tuple[str | None, str | None]:
    try:
        y = int(year)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None, None
    return f"{y:04d}-01-01", f"{y:04d}-12-31"


async def _resolve_id(ctx: TurnContext, kind: str, text: object) -> str | None:
    """Best-effort name → id for an author / location filter. A miss just
    means we don't constrain on it (the semantic search still runs)."""
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        hits = await ctx.catalog_repo.resolve(kind, text, lang=ctx.lang, limit=1)  # type: ignore[arg-type]
    except Exception:
        return None
    return hits[0].id if hits else None


async def _build_filters(ctx: TurnContext, args: dict) -> list[tuple[str, dict]]:
    """Ordered (relaxed-label, filter-kwargs) ladder: index 0 is fully
    constrained, each next entry drops the narrowest remaining constraint."""
    source_id = args.get("source_id") if isinstance(args.get("source_id"), str) else None
    # Delivery-date constraint: an explicit ISO range (date_from/date_to) wins;
    # otherwise derive a full-year range from a bare `year`. `anniversary_md`
    # ("MM-DD") narrows to that calendar day across all years. All three combine
    # freely with a topic so "лекции про карму за 1975" / "…9 июля" filter too.
    def _s(k: str) -> str | None:
        v = args.get(k)
        return v if isinstance(v, str) and v else None
    date_from, date_to = _s("date_from"), _s("date_to")
    if not date_from and not date_to:
        date_from, date_to = _year_range(args.get("year"))
    anniversary_md = _s("anniversary_md")
    author_id = await _resolve_id(ctx, "author", args.get("author"))
    location_id = await _resolve_id(ctx, "location", args.get("location"))

    full = {
        "author_id": author_id,
        "source_id": source_id,
        "location_id": location_id,
        "tag_ids": None,
        "date_from": date_from,
        "date_to": date_to,
        "anniversary_md": anniversary_md,
    }
    ladder: list[tuple[str, dict]] = [("", dict(full))]
    relaxed: list[str] = []
    for label, keys in (
        ("date", ("date_from", "date_to", "anniversary_md")),
        ("location", ("location_id",)),
        ("author", ("author_id",)),
        ("source", ("source_id",)),
    ):
        if not any(full[k] for k in keys):
            continue
        for k in keys:
            full[k] = None
        relaxed.append(label)
        ladder.append((",".join(relaxed), dict(full)))
    return ladder


async def _search(ctx: TurnContext, embedding: list[float], flt: dict) -> list[ScoredChunk]:
    eligible = None
    if any(flt.values()):
        eligible = await ctx.catalog_repo.filter_track_ids(**flt)
        if eligible is not None and not eligible:
            return []  # filters matched zero tracks — nothing to search
    return await ctx.chunk_repo.search_by_embedding(
        embedding,
        eligible_track_ids=eligible,
        lang=ctx.lang,
        top_k=_SEARCH_TOP_K,
    )


def _top_lectures(chunks: list[ScoredChunk]) -> list[ScoredChunk]:
    """One ScoredChunk per track — the chunk we'll QUOTE — ranked by the
    track's relevance and filtered to the score floor.

    Relevance = the track's best chunk score (intro or not). The quoted chunk
    is the best NON-intro chunk when one exists, else the best chunk.
    """
    by_track: dict[str, list[ScoredChunk]] = defaultdict(list)
    for sc in chunks:
        by_track[sc.chunk.track_id].append(sc)

    picked: list[tuple[float, ScoredChunk]] = []
    for scs in by_track.values():
        relevance = max(s.score for s in scs)
        if relevance < _MIN_SCORE:
            continue
        body = [s for s in scs if s.chunk.start_ms >= _INTRO_MS] or scs
        quote = max(body, key=lambda s: s.score)
        picked.append((relevance, quote))

    picked.sort(key=lambda p: p[0], reverse=True)
    return [q for _, q in picked[:_MAX_LECTURES]]


async def _describe(ctx: TurnContext, query: str, title: str, description: str, excerpt: str) -> str:
    """A short, grounded description of ONE lecture, tilted toward the user's
    question. Built from the lecture's own catalog description — NOT a verdict
    on whether it matches (that produced "this lecture is NOT about X")."""
    sys = (
        "You write a SHORT 1–2 sentence description of a lecture for a "
        "search-result card, in the user's language. Base it on the lecture's "
        "own description and the excerpt; bring out the part relevant to the "
        "user's question. Describe what the lecture COVERS — never comment on "
        "whether it matches the query, never say 'this lecture is about…'. "
        "Plain text, no markdown, do not repeat the title."
    )
    usr = (
        f"User question: {query}\n"
        f"Lecture title: {title or '—'}\n"
        f"Lecture description: {description or '—'}\n"
        f"Relevant excerpt: {excerpt[:300]}\n\n"
        f"Write the description in language code '{ctx.lang}'."
    )
    msgs: list[Message] = [{"role": "system", "content": sys}, {"role": "user", "content": usr}]
    try:
        out = await ctx.llm.structured_output(
            msgs, _Prose, model=get_settings().llm_cheap, run_name="find_tracks_description"
        )
    except Exception:  # noqa: BLE001 — a flaky cheap-model / parse miss on ONE card's
        # blurb must not blow up the whole find_track turn (it's gathered with the
        # others). Degrade to no description; the card still renders from its title.
        log.warning("find_tracks_description_failed", request_id=ctx.request_id)
        return ""
    return out.text.strip()


async def _intro(ctx: TurnContext, query: str, n: int, relaxed: str) -> str:
    sys = (
        "Write ONE short intro line (max ~14 words) in the user's language for "
        "a list of lectures found for the user's query — e.g. 'Вот лекции об "
        "очищении сердца:'. If some search filters were relaxed, mention it "
        "briefly. If zero lectures were found, say so plainly. Plain text only."
    )
    usr = (
        f"User query: {query}\n"
        f"Lectures found: {n}\n"
        f"Relaxed filters: {relaxed or 'none'}\n\n"
        f"Write the line in language code '{ctx.lang}'."
    )
    msgs: list[Message] = [{"role": "system", "content": sys}, {"role": "user", "content": usr}]
    try:
        out = await ctx.llm.structured_output(
            msgs, _Prose, model=get_settings().llm_cheap, run_name="find_tracks_intro"
        )
    except Exception:  # noqa: BLE001 — same resilience as _describe: a parse miss on
        # the lead-in must not kill the turn. Degrade to no intro line.
        log.warning("find_tracks_intro_failed", request_id=ctx.request_id)
        return ""
    return out.text.strip()


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
        return await _emit_empty(ctx, writer, query)

    embedding = await ctx.embedder.embed_query(query)
    ladder = await _build_filters(ctx, args)

    lectures: list[ScoredChunk] = []
    relaxed = ""
    for label, flt in ladder:
        chunks = await _search(ctx, embedding, flt)
        lectures = _top_lectures(chunks)
        if lectures:
            relaxed = label
            break

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
            return await _probe_and_answer_ref(ctx, writer, str(source_id), str(tokens))
        # A date-only query ("лекции, прочитанные 9 июля") is also invisible to
        # semantic search (no topic to embed). The catalog stores a per-track
        # date, so probe it directly by year range and/or "on this day" (MM-DD
        # across all years — the anniversary the user usually means).
        date_from = args.get("date_from")
        date_to = args.get("date_to")
        anniversary = args.get("anniversary_md")
        if date_from or date_to or anniversary:
            return await _probe_and_answer_date(
                ctx, writer, date_from, date_to, anniversary,
            )
        log.info("find_tracks_empty", request_id=ctx.request_id, query=query[:80])
        return await _emit_empty(ctx, writer, query)

    track_ids = [sc.chunk.track_id for sc in lectures]
    # Server-resolved display (title/author/date/refs) for thin clients, and
    # the per-track description — concurrently. A track the published catalog
    # doesn't carry has no display title → drop it (client can't render it).
    displays, outlines = await asyncio.gather(
        asyncio.gather(*(resolve_track_display(ctx, tid) for tid in track_ids)),
        asyncio.gather(*(ctx.catalog_repo.get_outline(tid, ctx.lang) for tid in track_ids)),
    )
    kept = [
        (sc, disp, (outline[1] or ""))
        for sc, disp, outline in zip(lectures, displays, outlines)
        if disp.get("track_title")
    ]
    if not kept:
        log.info("find_tracks_all_uncatalogued", request_id=ctx.request_id)
        return await _emit_empty(ctx, writer, query)

    # The only LLM hop — per-lecture descriptions + the global intro, all
    # concurrent. Each call sees ONE lecture; wall-clock ≈ one call.
    desc_tasks = [
        _describe(ctx, query, disp.get("track_title", ""), description, sc.chunk.text)
        for sc, disp, description in kept
    ]
    intro_task = _intro(ctx, query, len(kept), relaxed)
    prose = await asyncio.gather(intro_task, *desc_tasks)
    intro, descriptions = prose[0], list(prose[1:])

    writer({"type": "status", "data": {"key": "composing_answer"}})
    if intro:
        writer({"type": "delta", "data": {"text": intro + "\n\n"}})

    for (sc, disp, _description), desc_text in zip(kept, descriptions):
        chunk = sc.chunk
        tid = chunk.track_id
        if desc_text:
            writer({"type": "delta", "data": {"text": desc_text + "\n\n"}})

        # Card attribution payload — so a catalog-less client (web) can render
        # the lecture tile. Emitted BEFORE the [card:] marker.
        writer({
            "type": "action",
            "data": {"kind": "card", "id": tid, "payload": {"track_id": tid, **disp}},
        })

        ref = ctx.aliases.alias_chunk(tid, chunk.start_ms, chunk.end_ms, lang=chunk.lang)
        ctx.aliases.chunk_texts[ref] = chunk.text
        cite = await build_cite_payload(ctx, ref, ctx.aliases.resolve(ref))
        if cite is not None:
            writer({
                "type": "action",
                "data": {
                    "kind": "cite_transcript",
                    "id": f"cite_{tid}_{chunk.start_ms}_{chunk.end_ms}",
                    "payload": cite,
                },
            })

        marker = f"[card:{tid}]\n"
        if cite is not None:
            marker += f"[cite:{tid}@{chunk.start_ms}-{chunk.end_ms}]\n"
        writer({"type": "delta", "data": {"text": marker + "\n"}})

    log.info(
        "find_tracks_ok",
        request_id=ctx.request_id,
        n_lectures=len(kept),
        relaxed=relaxed,
    )
    return {}


def _emit_reply(writer, reply, *, prefix_line: str = "", suffix: str = "") -> None:
    """Stream a LocalizedReply: the line (optionally with a trailing `suffix`
    like the card block already emitted separately) then its follow-up chips,
    each as a `[followup:…]` marker on its own line."""
    line = (reply.line or "").strip()
    if line:
        writer({"type": "delta", "data": {"text": prefix_line + line + suffix}})
    for chip in reply.chips[:3]:
        chip = chip.replace("]", "").replace("|", "").strip()
        if chip:
            writer({"type": "delta", "data": {"text": f"\n[followup:{chip}]"}})


async def _resolve_source(ctx: TurnContext, source_id: str) -> tuple[str, str | None]:
    """Resolve a source arg to `(opaque_id, short_label)`. `source_id` may be an
    opaque catalog id (deterministic path) OR an abbreviation like "SB" (the LLM
    router emits the abbrev). Returns the opaque id needed for the ref lookup and
    the label localized to `ctx.lang` ("ШБ" for ru). Falls back to the input id
    and a None label when the repo can't resolve it."""
    if ctx.catalog_repo is None:
        return source_id, None
    try:
        short = await ctx.catalog_repo.source_short_label(source_id, lang=ctx.lang)
    except Exception:  # noqa: BLE001 — a label miss must never fail the turn
        short = None
    if short:  # source_id was already the opaque id
        return source_id, short
    try:
        hits = await ctx.catalog_repo.resolve("source", source_id, lang=None, limit=1)
    except Exception:  # noqa: BLE001
        hits = []
    # The resolved id DRIVES the lecture filter (source_id=opaque below), not
    # just the label — so a weak fuzzy match must not swap in the wrong book.
    # Require real confidence; below it, keep the input id (which won't match →
    # the honest "no lectures, show verses?" clarify) rather than serve a
    # different scripture.
    if not hits or hits[0].confidence < 0.6:
        return source_id, None
    opaque = hits[0].id
    try:
        short = await ctx.catalog_repo.source_short_label(opaque, lang=ctx.lang)
    except Exception:  # noqa: BLE001
        short = None
    return opaque, (short or hits[0].extra.get("short_name") or None)


async def _probe_and_answer_ref(
    ctx: TurnContext, writer, source_id: str, tokens: str
) -> dict:
    """Semantic search missed a bare scripture ref. Probe the catalog's
    lecture→verse index (deterministic, no embedding) and either SERVE the
    lectures it finds, or — when that index is also empty — ask whether the user
    wanted the verses themselves."""
    opaque, short = await _resolve_source(ctx, source_id)
    ref = f"{short} {tokens}" if short else tokens

    tracks = []
    parsed = parse_tokens(tokens)
    if parsed is not None and ctx.catalog_repo is not None:
        prefix, ref_from, ref_to = parsed
        try:
            tracks = await ctx.catalog_repo.list_tracks(
                author_id=None, source_id=opaque, location_id=None, tag_ids=None,
                title_query=None, date_from=None, date_to=None, lang=ctx.lang,
                limit=8, offset=0,
                ref_prefix=".".join(map(str, prefix)) or None,
                ref_from=ref_from, ref_to=ref_to,
            )
        except Exception:  # noqa: BLE001 — a probe miss falls back to the clarify
            log.exception("find_tracks_ref_probe_failed", request_id=ctx.request_id)
            tracks = []

    writer({"type": "status", "data": {"key": "composing_answer"}})
    cards = await _renderable(ctx, tracks)

    if cards:
        # SERVE: these are the lectures semantic search missed. Emit a lead-in
        # (LLM-localized to the user's language), one card per lecture, and a
        # chip to see the verses instead. The count is of RENDERABLE cards
        # (title-less ones dropped), so it never claims more than it shows.
        log.info(
            "find_tracks_ref_served", request_id=ctx.request_id,
            source_id=opaque, tokens=tokens, n=len(cards),
        )
        reply = await localized_reply(
            ctx,
            f"Found {len(cards)} lecture(s) that discuss the verses {ref}. Write a "
            f"one-line lead-in for the list below. Add ONE chip that means 'show "
            f"the verses {ref} themselves' and includes '{ref}'.",
        )
        _emit_reply(writer, LocalizedReply(line=reply.line or "", chips=[]), suffix="\n\n")
        _stream_cards(writer, cards)
        for chip in (reply.chips or [])[:1]:
            chip = chip.replace("]", "").replace("|", "").strip()
            if chip:
                writer({"type": "delta", "data": {"text": f"[followup:{chip}]"}})
        return {}

    # The ref-index is empty too — ask whether they wanted the verses.
    log.info(
        "find_tracks_ref_clarify", request_id=ctx.request_id,
        source_id=opaque, tokens=tokens,
    )
    reply = await localized_reply(
        ctx,
        f"No lectures were found on {ref}. Ask, in one short line, whether the "
        f"user wants to read the verses {ref} themselves. Add ONE chip meaning "
        f"'show verses {ref}' that includes '{ref}'.",
    )
    _emit_reply(writer, reply)
    return {}


async def _probe_and_answer_date(
    ctx: TurnContext, writer, date_from, date_to, anniversary_md,
) -> dict:
    """A date-only query has no topic to embed, so probe the catalog's per-track
    date index directly: `date_from`/`date_to` bound a year/range, `anniversary_md`
    ("MM-DD") matches that calendar day across ALL years ("in this day in
    history"). Serve what's found, else say so honestly."""
    tracks = []
    if ctx.catalog_repo is not None:
        try:
            tracks = await ctx.catalog_repo.list_tracks(
                author_id=None, source_id=None, location_id=None, tag_ids=None,
                title_query=None, date_from=date_from, date_to=date_to, lang=ctx.lang,
                limit=8, offset=0, anniversary_md=anniversary_md,
            )
        except Exception:  # noqa: BLE001 — a probe miss falls back to the empty line
            log.exception("find_tracks_date_probe_failed", request_id=ctx.request_id)
            tracks = []
    # A plain-English description of the requested date so the localized lead-in
    # states the RIGHT date (never invents one — the LLM has no date otherwise).
    if anniversary_md and "-" in anniversary_md:
        mm, dd = anniversary_md.split("-", 1)
        date_desc = (
            f"the recurring calendar day — month {int(mm)}, day {int(dd)} "
            f"(i.e. day {int(dd)} of month {int(mm)}) — across ALL years, an "
            f"anniversary (NOT one specific year)"
        )
    elif date_from and date_to:
        date_desc = f"the date range {date_from} to {date_to} (ISO YYYY-MM-DD)"
    elif date_from:
        date_desc = f"on or after {date_from} (ISO YYYY-MM-DD)"
    else:
        date_desc = f"on or before {date_to} (ISO YYYY-MM-DD)"

    writer({"type": "status", "data": {"key": "composing_answer"}})
    cards = await _renderable(ctx, tracks)
    if cards:
        log.info(
            "find_tracks_date_served", request_id=ctx.request_id,
            date_from=date_from, date_to=date_to, anniversary_md=anniversary_md,
            n=len(cards),
        )
        reply = await localized_reply(
            ctx,
            f"Found {len(cards)} lecture(s) delivered on {date_desc}. Write a "
            f"one-line lead-in that names this date NATURALLY in the user's "
            f"language (e.g. 'лекции за 9 июля'). Use ONLY this date — do not "
            f"invent a specific year or a different date. No chips.",
        )
        _emit_reply(writer, LocalizedReply(line=reply.line or "", chips=[]), suffix="\n\n")
        _stream_cards(writer, cards)
        return {}
    reply = await localized_reply(
        ctx, f"No lectures were found for {date_desc}. Say so in one short line, "
             f"naming the date naturally in the user's language. No invented "
             f"dates. No chips.",
    )
    _emit_reply(writer, reply)
    return {}


async def _renderable(ctx: TurnContext, tracks) -> list[tuple[str, dict]]:
    """Resolve display attribution for each track, DROPPING any with no title —
    a catalog-less client can't render it (same invariant as the main find
    path). Returns [(track_id, payload), …] so the caller can size the lead-in
    to what will actually show and fall through when nothing is renderable."""
    out: list[tuple[str, dict]] = []
    for track in tracks:
        disp = await resolve_track_display(ctx, track.id)
        title = disp.get("track_title") or track.title
        if not title:
            continue
        out.append((track.id, {"track_id": track.id, **disp, "track_title": title}))
    return out


def _stream_cards(writer, cards: list[tuple[str, dict]]) -> None:
    """Emit one card action + `[card:id]` marker per resolved card
    (payload-before-marker, honouring the SSE ordering invariant)."""
    for track_id, payload in cards:
        writer({"type": "action",
                "data": {"kind": "card", "id": track_id, "payload": payload}})
        writer({"type": "delta", "data": {"text": f"[card:{track_id}]\n\n"}})


async def _emit_empty(ctx: TurnContext, writer, query: str) -> dict:
    """No lectures found — one localized line, nothing else."""
    writer({"type": "status", "data": {"key": "composing_answer"}})
    line = ""
    if ctx.llm is not None and query:
        try:
            line = await _intro(ctx, query, 0, "")
        except Exception:
            log.exception("find_tracks_empty_intro_failed", request_id=ctx.request_id)
    if line:
        writer({"type": "delta", "data": {"text": line}})
    return {}
