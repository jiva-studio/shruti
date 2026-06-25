"""Find-tracks worker — DETERMINISTIC lecture search (intent=find_tracks).

The user asks to FIND lectures about a topic ("найди лекцию про очищение
сердца"). Unlike `research` (which synthesizes an essay), this returns the
LECTURES THEMSELVES as a ranked list of cards, each with a verbatim
transcript quote showing why it matched.

Everything happens in this node, which terminates at END (no synthesizer):

1. Embed the query and semantic-search transcript chunks, constrained by
   the metadata filters the router extracted (source / year / author /
   location). Group by track, keep the best-scoring chunk per lecture, take
   the top N. Progressive relaxation: if the filters yield nothing, drop
   them one by one and retry so we always surface SOMETHING.
2. Per lecture, pull its catalog description (the verbatim quote is just the
   best chunk's text) — all reads run concurrently.
3. Headers are the ONLY LLM hop and the only thing the model writes: one
   independent call per lecture ({title, description, question} → one line)
   plus one global header, all run concurrently. The model never sees a
   track_id or an array, so there is nothing for it to mis-order or
   hallucinate.
4. Emit deterministically, straight to the client (bypassing the synthesizer
   like `action_responder`): the global header, then per lecture a header, a
   `[card:track]` tile and a `[cite:…]` quote — each quote's `cite_transcript`
   action payload is force-emitted first, honouring the action-before-marker
   ordering invariant.
"""

from __future__ import annotations

import asyncio

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime
from pydantic import BaseModel

from shruti_chat.agent.graph.nodes._worker_common import build_cite_payload
from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.config import get_settings
from shruti_chat.domain.entities import Message, ScoredChunk
from shruti_chat.observability.logging import bind_node_role, get_logger

log = get_logger(__name__)

# At most five lecture cards — the user scans a short, scannable list and
# adds one to a playlist; beyond that the LLM header fan-out and the wall of
# quotes stop being useful.
_MAX_LECTURES = 5
# Pull more chunks than lectures so grouping-by-track still yields a full
# list when several top chunks belong to the same lecture.
_SEARCH_TOP_K = 16


class _Header(BaseModel):
    """One header line, the sole text the model produces this turn."""

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
    """Build the ordered (label, filter-kwargs) relaxation ladder.

    Index 0 is the fully-constrained filter; each subsequent entry drops the
    narrowest remaining constraint. The labels name what was relaxed so the
    global header can tell the user ("по 1976 не нашлось, показываю без года").
    """
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
    # Relax narrowest first: year, then location, then author, then source.
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
    """Best-scoring chunk per track, ranked by that score, capped at N."""
    best: dict[str, ScoredChunk] = {}
    for sc in chunks:
        cur = best.get(sc.chunk.track_id)
        if cur is None or sc.score > cur.score:
            best[sc.chunk.track_id] = sc
    ranked = sorted(best.values(), key=lambda sc: sc.score, reverse=True)
    return ranked[:_MAX_LECTURES]


async def _header(ctx: TurnContext, query: str, title: str, description: str) -> str:
    """One per-lecture header. Independent call — the model only ever sees a
    single lecture, so there is no list to mis-order and no id to mangle."""
    sys = (
        "You write ONE short header line (max ~12 words) for a lecture card in "
        "a search result, in the user's language. Given the user's query and a "
        "lecture's title and description, say how THIS lecture speaks to the "
        "query. Plain text only — no quotes, no markdown, no lecture title."
    )
    usr = (
        f"User query: {query}\n"
        f"Lecture title: {title or '—'}\n"
        f"Lecture description: {description or '—'}\n\n"
        f"Write the header in language code '{ctx.lang}'."
    )
    msgs: list[Message] = [{"role": "system", "content": sys}, {"role": "user", "content": usr}]
    out = await ctx.llm.structured_output(
        msgs, _Header, model=get_settings().llm_cheap, run_name="find_tracks_header"
    )
    return out.text.strip()


async def _global_header(ctx: TurnContext, query: str, n: int, relaxed: str) -> str:
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
        msgs, _Header, model=get_settings().llm_cheap, run_name="find_tracks_global_header"
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
        log.info("find_tracks_empty", request_id=ctx.request_id, query=query[:80])
        return await _emit_empty(ctx, writer, query)

    track_ids = [sc.chunk.track_id for sc in lectures]
    titles = await ctx.catalog_repo.get_titles(track_ids, lang=ctx.lang)
    descriptions = await asyncio.gather(
        *(ctx.catalog_repo.get_outline(tid, ctx.lang) for tid in track_ids)
    )
    desc_by_track = {tid: (d[1] or "") for tid, d in zip(track_ids, descriptions)}

    # Headers are the only LLM hop — fan out one tiny call per lecture plus
    # the global header, all concurrently. wall-clock ≈ one call.
    header_tasks = [
        _header(ctx, query, titles.get(tid, ""), desc_by_track[tid]) for tid in track_ids
    ]
    global_task = _global_header(ctx, query, len(lectures), relaxed)
    headers = await asyncio.gather(global_task, *header_tasks)
    global_header, lecture_headers = headers[0], list(headers[1:])

    writer({"type": "status", "data": {"key": "composing_answer"}})
    writer({"type": "delta", "data": {"text": global_header + "\n\n"}})

    for sc, header in zip(lectures, lecture_headers):
        chunk = sc.chunk
        # Fallback to the lecture title if the header model returned nothing.
        line = header or titles.get(chunk.track_id, "")
        if line:
            writer({"type": "delta", "data": {"text": f"### {line}\n"}})

        ref = ctx.aliases.alias_chunk(chunk.track_id, chunk.start_ms, chunk.end_ms, lang=chunk.lang)
        ctx.aliases.chunk_texts[ref] = chunk.text
        payload = await build_cite_payload(ctx, ref, ctx.aliases.resolve(ref))

        # Action-before-marker: ship the quote payload, THEN the markers that
        # reference it (the tappable lecture tile + the quote).
        if payload is not None:
            writer({
                "type": "action",
                "data": {
                    "kind": "cite_transcript",
                    "id": f"cite_{chunk.track_id}_{chunk.start_ms}_{chunk.end_ms}",
                    "payload": payload,
                },
            })
        marker = f"[card:{chunk.track_id}]\n"
        if payload is not None:
            marker += f"[cite:{chunk.track_id}@{chunk.start_ms}-{chunk.end_ms}]\n"
        writer({"type": "delta", "data": {"text": marker + "\n"}})

    log.info(
        "find_tracks_ok",
        request_id=ctx.request_id,
        n_lectures=len(lectures),
        relaxed=relaxed,
    )
    return {}


async def _emit_empty(ctx: TurnContext, writer, query: str) -> dict:
    """No lectures found — one localized line, nothing else."""
    writer({"type": "status", "data": {"key": "composing_answer"}})
    line = ""
    if ctx.llm is not None and query:
        try:
            line = await _global_header(ctx, query, 0, "")
        except Exception:
            log.exception("find_tracks_empty_header_failed", request_id=ctx.request_id)
    if line:
        writer({"type": "delta", "data": {"text": line}})
    return {}
