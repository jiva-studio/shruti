"""corpus_fanout — parallel ANN across {lecture, verse, commentary,
prose_chapter, letter} with optional topic-boost.

Operates on raw chunks (not envelopes) until the very end so topic-boost
can look up the underlying track_id / item_id directly. Envelopes are
minted on the final selection — this is also the only place we mint
aliases, so we don't pollute TurnAliasMap with chunks that get filtered out.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

from lectorium_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
)
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.constants import BOOST_BY_KIND, TOPK_PER_QUERY
from lectorium_chat.research.models import FanoutResult


OnEvent = Callable[[str, dict[str, Any]], None]


def _label_for_lecture_chunk(c: Any) -> str:
    """Short preview for a lecture chunk — first line of text (~80 chars)
    is what the user finds informative: track_id alone is opaque, the
    timecode is meaningless without title context. Bounded to keep the
    panel chip small."""
    text = (getattr(c, "text", "") or "").strip().replace("\n", " ")
    if len(text) > 80:
        return text[:79].rstrip() + "…"
    return text or getattr(c, "track_id", "") or "lecture"


def _label_for_library_chunk(c: Any) -> str:
    addr = getattr(c, "addr_label", "") or ""
    addr = addr.strip()
    if addr:
        return addr
    return getattr(c, "item_id", "") or "library"


def _emit_research_source(on_event: OnEvent | None, r: "_RawScored") -> None:
    """Surface one inspected source live, BEFORE dedup/boost/sort. The
    client dedups by `id` on its side."""
    if on_event is None:
        return
    chunk = r.chunk
    try:
        if r.kind == "lecture":
            track_id = getattr(chunk, "track_id", "")
            start_ms = getattr(chunk, "start_ms", 0)
            on_event(
                "research_source",
                {
                    "kind": "lecture_chunk",
                    "id": f"lecture:{track_id}:{start_ms}",
                    "label": _label_for_lecture_chunk(chunk),
                },
            )
        elif r.kind == "verse":
            item_id = getattr(chunk, "item_id", "")
            on_event(
                "research_source",
                {
                    "kind": "verse",
                    "id": f"verse:{item_id}",
                    "label": _label_for_library_chunk(chunk),
                },
            )
        else:
            # commentary / prose_chapter / letter → library_doc on the
            # wire (the panel doesn't need to distinguish them visually).
            # Use the `library:<item_id>` namespace — same as
            # `_emit_source_for_ref` in pipeline.py — so a library doc
            # discovered via BOTH the attribution-refs path AND the
            # fanout path lands on the same client-side id and the
            # client's dedup-by-id collapses the duplicate.
            item_id = getattr(chunk, "item_id", "")
            on_event(
                "research_source",
                {
                    "kind": "library_doc",
                    "id": f"library:{item_id}",
                    "label": _label_for_library_chunk(chunk),
                },
            )
    except Exception:  # noqa: BLE001 — observability must never break fanout
        log.warning("on_event_research_source_failed", kind=r.kind)


log = get_logger(__name__)


_LIBRARY_KINDS = ("verse", "commentary", "prose_chapter", "letter")
_RELEVANCE_FLOOR = 0.45   # match chunks_search behaviour


@dataclass
class _RawScored:
    """Internal — pairs a raw chunk with its score and the kind label.

    We keep `kind` separate because lecture chunks (Chunk) don't have
    `item_kind` but library chunks (LibraryChunk) do.
    """

    chunk: Any
    score: float
    kind: str           # "lecture" | "verse" | "commentary" | "prose_chapter" | "letter"
    dedup_key: tuple    # used to dedupe across queries and rounds


def _lecture_dedup_key(c: Any) -> tuple:
    return ("lecture", c.track_id, c.start_ms, c.end_ms)


def _library_dedup_key(c: Any) -> tuple:
    return (c.item_kind, c.item_id, c.segment_index)


def _lecture_item_id(c: Any) -> str:
    return c.track_id


def _library_item_id(c: Any) -> str:
    return c.item_id


async def fanout_search_with_boost(
    queries: list[str],
    *,
    embedder: Any,
    chunk_repo: Any,
    catalog_repo: Any,
    alias_map: Any,
    lang: str | None = None,
    boost_ids: set[str] | None = None,
    boost_by_kind: dict[str, float] | None = None,
    top_k: int = TOPK_PER_QUERY,
    author_id: str | None = None,
    location_id: str | None = None,
    tag_ids: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    book_id: str | None = None,
    on_event: OnEvent | None = None,
) -> FanoutResult:
    """One round of fanout. Returns top-K (boosted) envelopes."""
    if not queries:
        return FanoutResult()
    boost_ids = boost_ids or set()
    k = max(1, min(top_k, 16))

    # 1. Batched embed.
    q_vecs = await embedder.embed_documents(queries)
    if len(q_vecs) != len(queries):
        log.warning("fanout_embed_mismatch", queries=len(queries), vectors=len(q_vecs))
        q_vecs = q_vecs[: len(queries)]

    # 2. Eligible-track filter (catalog-driven; independent of query).
    eligible_track_ids = await catalog_repo.filter_track_ids(
        author_id=author_id, source_id=book_id, location_id=location_id,
        tag_ids=tag_ids, date_from=date_from, date_to=date_to,
    )
    lectures_disabled = eligible_track_ids is not None and not eligible_track_ids

    async def _one_query(q_vec: list[float]) -> list[_RawScored]:
        async def _lecture(use_lang: str | None) -> list[_RawScored]:
            if lectures_disabled:
                return []
            scored = await chunk_repo.search_by_embedding(
                q_vec, eligible_track_ids=eligible_track_ids, lang=use_lang, top_k=k,
            )
            return [_RawScored(s.chunk, s.score, "lecture", _lecture_dedup_key(s.chunk)) for s in scored]

        async def _library(use_lang: str | None, kinds: list[str]) -> list[_RawScored]:
            scored = await chunk_repo.search_library_by_embedding(
                q_vec, kinds=kinds, source_id=book_id, author_id=author_id,
                lang=use_lang, date_from=date_from, date_to=date_to, top_k=k,
            )
            return [_RawScored(s.chunk, s.score, s.chunk.item_kind, _library_dedup_key(s.chunk)) for s in scored]

        async def _run(use_lang: str | None) -> list[_RawScored]:
            lec, lib = await asyncio.gather(
                _lecture(use_lang),
                _library(use_lang, list(_LIBRARY_KINDS)),
            )
            return lec + lib

        rows = await _run(lang)
        if not rows and lang is not None:
            rows = await _run(None)
        # Surface what THIS query touched live, before the global dedup
        # and ranking — the user wants "I'm looking at this now", not
        # "I picked these after thinking". Floor matches the post-dedup
        # filter so we don't stream obvious noise.
        for r in rows:
            if r.score < _RELEVANCE_FLOOR:
                continue
            _emit_research_source(on_event, r)
        return rows

    # 3. Run the parallel fanout queries.
    per_query = await asyncio.gather(*(_one_query(v) for v in q_vecs))

    # 4. Apply topic boost FIRST (before the relevance floor) so an
    # attribution-flagged chunk isn't filtered out for having a low base
    # score. A short verse-chunk under-scores against a long query and
    # sits at ~0.30; the floor at 0.45 would silently drop it before
    # ranking even has a chance. If the curator's attribution says
    # "this item is relevant", we trust it past the noise floor.
    # Per-kind dict makes per-corpus lift tunable without code change.
    boost_map = boost_by_kind if boost_by_kind is not None else BOOST_BY_KIND
    boosted_flags: dict[tuple, bool] = {}
    for batch in per_query:
        for r in batch:
            if boost_ids:
                iid = _lecture_item_id(r.chunk) if r.kind == "lecture" else _library_item_id(r.chunk)
                if iid in boost_ids:
                    lift = boost_map.get(r.kind, 0.0)
                    if lift > 0.0:
                        r.score = min(1.0, r.score + lift)
                        boosted_flags[r.dedup_key] = True

    # 5. Dedup + relevance floor (after boost so curator-flagged chunks
    # get a chance to clear the floor).
    deduped: dict[tuple, _RawScored] = {}
    for batch in per_query:
        for r in batch:
            if r.score < _RELEVANCE_FLOOR:
                continue
            prev = deduped.get(r.dedup_key)
            if prev is None or prev.score < r.score:
                deduped[r.dedup_key] = r

    # 5. Sort + take top-K.
    ranked = sorted(deduped.values(), key=lambda r: r.score, reverse=True)[:k]

    # Telemetry: per-kind distribution in the dedup pool (before slicing)
    # vs the top-K. Lets us see when verse-chunks exist in the candidate
    # pool but lose to lectures in ranking — driving the boost-tuning
    # conversation with data instead of guesses.
    candidate_by_kind: dict[str, int] = {}
    boosted_by_kind: dict[str, int] = {}
    for r in deduped.values():
        candidate_by_kind[r.kind] = candidate_by_kind.get(r.kind, 0) + 1
        if boosted_flags.get(r.dedup_key):
            boosted_by_kind[r.kind] = boosted_by_kind.get(r.kind, 0) + 1
    topk_by_kind: dict[str, int] = {}
    for r in ranked:
        topk_by_kind[r.kind] = topk_by_kind.get(r.kind, 0) + 1
    log.info(
        "fanout_kind_distribution",
        candidates_total=len(deduped),
        candidates_by_kind=candidate_by_kind,
        boosted_by_kind=boosted_by_kind,
        topk_by_kind=topk_by_kind,
        boost_ids_count=len(boost_ids),
    )

    # 6. Envelope (mints aliases) and build by_kind partition.
    envelopes: list[dict[str, Any]] = []
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for r in ranked:
        if r.kind == "lecture":
            env = lecture_to_envelope(r.chunk, alias_map=alias_map, score=r.score)
        else:
            env = library_to_envelope(r.chunk, alias_map=alias_map, score=r.score)
        if boosted_flags.get(r.dedup_key):
            env["topic_boosted"] = True
        # Add dedup_key to envelope for merge_fanout — caller-private field.
        env["_dedup_key"] = r.dedup_key
        envelopes.append(env)
        by_kind.setdefault(r.kind, []).append(env)

    max_score = ranked[0].score if ranked else 0.0
    return FanoutResult(
        chunks=envelopes,
        by_kind=by_kind,
        max_score=max_score,
        rounds_executed=1,
    )


def merge_fanout(a: FanoutResult, b: FanoutResult) -> FanoutResult:
    """Merge two rounds. Dedup on the internal `_dedup_key` field added by
    `fanout_search_with_boost`; keep max score on conflicts."""
    by_key: dict[tuple, dict[str, Any]] = {}
    for r in (a, b):
        for env in r.chunks:
            key = env.get("_dedup_key")
            if key is None:
                continue
            score = env.get("score") or 0.0
            prev = by_key.get(key)
            if prev is None or (prev.get("score") or 0.0) < score:
                by_key[key] = env
    merged = sorted(by_key.values(), key=lambda e: e.get("score") or 0.0, reverse=True)
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for env in merged:
        by_kind.setdefault(env.get("type") or "unknown", []).append(env)
    return FanoutResult(
        chunks=merged,
        by_kind=by_kind,
        max_score=merged[0].get("score") if merged else 0.0,
        rounds_executed=max(a.rounds_executed, b.rounds_executed),
    )
