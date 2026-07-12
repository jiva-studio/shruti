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
    build_cite_payload,
    resolve_track_display,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.config import get_settings
from lectorium_chat.domain.entities import Message, ScoredChunk
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
    date_from, date_to = _year_range(args.get("year"))
    author_id = await _resolve_id(ctx, "author", args.get("author"))
    location_id = await _resolve_id(ctx, "location", args.get("location"))

    full = {
        "author_id": author_id,
        "source_id": source_id,
        "location_id": location_id,
        "tag_ids": None,
        "date_from": date_from,
        "date_to": date_to,
    }
    ladder: list[tuple[str, dict]] = [("", dict(full))]
    relaxed: list[str] = []
    for label, keys in (
        ("year", ("date_from", "date_to")),
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
    out = await ctx.llm.structured_output(
        msgs, _Prose, model=get_settings().llm_cheap, run_name="find_tracks_description"
    )
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
    out = await ctx.llm.structured_output(
        msgs, _Prose, model=get_settings().llm_cheap, run_name="find_tracks_intro"
    )
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
        # A bare scripture reference that matched no lecture is AMBIGUOUS, not a
        # dead end: the user may want to READ those verses, not find a talk on
        # them. Instead of a flat "no lectures were found" (the old behaviour on
        # e.g. "sb 1.2.6-1.2.18"), ask one grounded question and offer the two
        # concrete paths as follow-up chips. The chips carry the ref verbatim so
        # the tap re-routes correctly via followup_rewrite. Deterministic +
        # localized — no LLM hop, so the question streams instantly.
        source_id = args.get("source_id")
        tokens = args.get("tokens")
        if source_id and tokens:
            log.info(
                "find_tracks_ref_clarify",
                request_id=ctx.request_id,
                source_id=source_id,
                tokens=tokens,
            )
            return await _emit_ref_clarify(ctx, writer, source_id, str(tokens))
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


# Localized "we found the reference but no lecture — verses or lectures?"
# clarification. Kept deterministic (no LLM) so it streams instantly and is
# trivially testable. `{ref}` is the human address ("ШБ 1.2.6-1.2.18"). Each
# chip carries the ref verbatim so the tapped follow-up re-routes correctly.
# en is the fallback for any locale not listed.
_REF_CLARIFY: dict[str, tuple[str, str, str]] = {
    "ru": (
        "По запросу «{ref}» лекций не нашлось. "
        "Показать сами стихи или найти лекции по этой теме?",
        "Показать стихи {ref}",
        "Найти лекции по теме {ref}",
    ),
    "en": (
        "No lectures matched «{ref}». "
        "Would you like the verses themselves, or lectures on this topic?",
        "Show verses {ref}",
        "Find lectures on {ref}",
    ),
}


async def _source_short(ctx: TurnContext, source_id: str) -> str | None:
    """Best-effort short label ("ШБ") for a source. `source_id` may be an
    opaque catalog id (deterministic path) OR an abbreviation like "SB" (the
    LLM router emits the abbrev). `source_short_label` matches the opaque id
    by exact equality and does NOT normalize, so on the abbrev path we fall
    back to resolving the name and reading its `short_name`."""
    if ctx.catalog_repo is None:
        return None
    try:
        short = await ctx.catalog_repo.source_short_label(source_id, lang=ctx.lang)
    except Exception:  # noqa: BLE001 — a label miss must never fail the turn
        short = None
    if short:
        return short
    try:
        hits = await ctx.catalog_repo.resolve("source", source_id, lang=None, limit=1)
    except Exception:  # noqa: BLE001
        return None
    if hits:
        return hits[0].extra.get("short_name") or hits[0].full_name or None
    return None


async def _emit_ref_clarify(
    ctx: TurnContext, writer, source_id: str, tokens: str
) -> dict:
    """Ask whether the user wants the verses or lectures for a bare ref that
    matched no lecture, with two self-contained follow-up chips."""
    writer({"type": "status", "data": {"key": "composing_answer"}})
    short = await _source_short(ctx, source_id)
    ref = f"{short} {tokens}" if short else tokens
    question, chip_verses, chip_lectures = _REF_CLARIFY.get(ctx.lang, _REF_CLARIFY["en"])
    writer({"type": "delta", "data": {"text": question.format(ref=ref)}})
    writer({"type": "delta", "data": {"text": f"\n[followup:{chip_verses.format(ref=ref)}]"}})
    writer({"type": "delta", "data": {"text": f"\n[followup:{chip_lectures.format(ref=ref)}]"}})
    return {}


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
