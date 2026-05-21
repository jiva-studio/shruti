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
from typing import Any

from shruti_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
)
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.constants import DEFAULT_TOPIC_BOOST, TOPK_PER_QUERY
from shruti_chat.research.models import FanoutResult


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
    boost_factor: float = DEFAULT_TOPIC_BOOST,
    top_k: int = TOPK_PER_QUERY,
    author_id: str | None = None,
    location_id: str | None = None,
    tag_ids: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    book_id: str | None = None,
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
        return rows

    # 3. Parallel fanout, dedup by dedup_key (keep max score).
    per_query = await asyncio.gather(*(_one_query(v) for v in q_vecs))
    deduped: dict[tuple, _RawScored] = {}
    for batch in per_query:
        for r in batch:
            if r.score < _RELEVANCE_FLOOR:
                continue
            prev = deduped.get(r.dedup_key)
            if prev is None or prev.score < r.score:
                deduped[r.dedup_key] = r

    # 4. Apply topic boost on RAW chunks (item_id directly available).
    boosted_flags: dict[tuple, bool] = {}
    if boost_ids:
        for key, r in deduped.items():
            iid = _lecture_item_id(r.chunk) if r.kind == "lecture" else _library_item_id(r.chunk)
            if iid in boost_ids:
                r.score = min(1.0, r.score + boost_factor)
                boosted_flags[key] = True

    # 5. Sort + take top-K.
    ranked = sorted(deduped.values(), key=lambda r: r.score, reverse=True)[:k]

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
