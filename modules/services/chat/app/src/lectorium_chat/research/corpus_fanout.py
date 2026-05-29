"""corpus_fanout — parallel ANN across {lecture, verse, commentary,
prose_chapter, letter} with optional topic-boost.

Operates on raw chunks (not envelopes) until the very end so topic-boost
can look up the underlying track_id / item_id directly. Envelopes are
minted on the final selection — this is also the only place we mint
aliases, so we don't pollute TurnAliasMap with chunks that get filtered out.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any, Callable

from lectorium_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
)
from lectorium_chat.agent.tools._helpers import BOOK_PREFIX
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.constants import (
    ADDRESS_HIT_SCORE,
    LEXICAL_FETCH_TOP_K,
    LEXICAL_TRGM_MIN_SIM,
    RERANK_FETCH_TOP_K,
    RERANK_MIN_LECTURES,
    RERANK_MIN_LIBRARY,
    RERANK_MIN_VERSES,
    RERANK_NOISE_PREFLOOR,
    RERANK_POOL_CAP,
    RERANK_RESERVE_FLOOR,
    RERANK_TOP_K,
    TOPK_PER_QUERY,
)
from lectorium_chat.research.models import FanoutResult


# Every book prefix (ru + en) → canonical addr_label form, e.g. "БГ"/"BG" →
# matched against the chunks' stored `addr_label`. Built once from BOOK_PREFIX.
_ADDR_PREFIXES: list[str] = sorted(
    {p for m in BOOK_PREFIX.values() for p in m.values()},
    key=len, reverse=True,   # longest-first so "ЧЧ Мадхйа" wins over "ЧЧ"
)
_ADDR_RE = re.compile(
    r"(?P<prefix>" + "|".join(re.escape(p) for p in _ADDR_PREFIXES) + r")\s*"
    r"(?P<tokens>\d[\d.,\-–]*)",
    re.IGNORECASE,
)


def _parse_addresses(text: str) -> list[str]:
    """Extract canonical `addr_label`s ("БГ 2.13", "SB 1.1.1") mentioned in the
    query, so the fanout can fetch the exact verse/commentary deterministically
    instead of hoping dense ANN matches a number. Returns composed addr_labels
    (e.g. "БГ 2.13") ready for `get_chunks_by_addr_label`."""
    out: list[str] = []
    for m in _ADDR_RE.finditer(text or ""):
        prefix = m.group("prefix")
        tokens = m.group("tokens").rstrip(".,-–")
        # Normalise the matched prefix to its canonical stored casing by
        # finding the BOOK_PREFIX value it case-insensitively equals.
        canon = next(
            (p for p in _ADDR_PREFIXES if p.lower() == prefix.lower()), prefix
        )
        out.append(f"{canon} {tokens}")
    return out


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
    """Human-readable label for a library chunk's pill in the chat status.

    Order of preference:
      1. `addr_label` produced by the indexer (e.g. "BG 2.13",
         "Letter to Brahmananda, 1972-10-04") — the canonical short form.
      2. Compose `source_id + tokens` when addr_label was lost — same
         pattern `_verse_addr` uses in the indexer, so e.g. a verse with
         source_id="BG" and tokens="2.13" renders as "BG 2.13".
      3. `doc_date` for letters with no source/tokens.
      4. Generic kind-aware fallback ("verse" / "library document") —
         NEVER the raw `item_id`. Raw UUID-like ids leaking into the
         status pill is issue #660.
    """
    addr = (getattr(c, "addr_label", "") or "").strip()
    if addr:
        return addr
    source_id = (getattr(c, "source_id", "") or "").strip()
    tokens = (getattr(c, "tokens", "") or "").strip()
    if source_id and tokens:
        return f"{source_id} {tokens}"
    if source_id:
        return source_id
    doc_date = (getattr(c, "doc_date", "") or "").strip()
    item_kind = (getattr(c, "item_kind", "") or "").strip()
    if item_kind == "letter":
        return f"Letter, {doc_date}" if doc_date else "Letter"
    if item_kind == "verse":
        return "verse"
    return "library document"


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

    `sub_query_id` tracks which planner-produced sub-question this chunk came
    from, so the downstream synthesis planner can group notes by sub-topic.
    Same chunk surfaced by multiple sub-queries gets the sub_query_id of
    the highest-scoring hit (handled by the score-based dedup below).
    """

    chunk: Any
    score: float
    kind: str           # "lecture" | "verse" | "commentary" | "prose_chapter" | "letter"
    dedup_key: tuple    # used to dedupe across queries and rounds
    sub_query_id: int | None = None
    # Cross-encoder relevance, set only on the rerank path. Drives ordering
    # and the final cut; `score` (cosine) stays untouched for the gates.
    rerank_score: float | None = None
    # Hybrid recall: surfaced by the lexical lane / address fast-path, not
    # dense ANN. Forced members bypass the cosine floor and are guaranteed
    # into the rerank pool (the cross-encoder then judges them on text).
    # They still carry their TRUE cosine in `score`, so the gates stay honest.
    forced: bool = False


def _lecture_dedup_key(c: Any) -> tuple:
    return ("lecture", c.track_id, c.start_ms, c.end_ms)


def _library_dedup_key(c: Any) -> tuple:
    return (c.item_kind, c.item_id, c.segment_index)


async def _rerank_pool(
    deduped: dict[tuple, _RawScored],
    *,
    reranker: Any,
    rerank_query: str | None,
) -> list[_RawScored]:
    """Cross-encode the deduped pool against the question and cut by fixed
    top-k with a lecture reserve. Sets `rerank_score` on survivors (cosine
    `score` stays untouched). On any rerank failure, falls back to the
    cosine ordering for this round.

    Pool is pre-capped to RERANK_POOL_CAP by cosine to bound the call. Forced
    (hybrid lexical / address) hits are guaranteed into the pool past that cap —
    a lexical-surfaced verse often has a low cosine and would be cut by the
    pre-cap before the cross-encoder ever judged it on its text.
    """
    by_cos = sorted(deduped.values(), key=lambda r: r.score, reverse=True)
    pool = by_cos[:RERANK_POOL_CAP]
    if len(pool) < len(by_cos):
        in_pool = {r.dedup_key for r in pool}
        pool += [r for r in by_cos[RERANK_POOL_CAP:]
                 if r.forced and r.dedup_key not in in_pool]
    if len(pool) <= 1:
        for r in pool:
            r.rerank_score = r.score
        return pool

    texts = [(getattr(r.chunk, "text", "") or "").strip() for r in pool]
    try:
        scored = await reranker.rerank(rerank_query, texts)
    except Exception as exc:  # noqa: BLE001 — a turn never fails on the reranker
        log.warning("fanout_rerank_failed", error=str(exc), pool=len(pool))
        return sorted(pool, key=lambda r: r.score, reverse=True)[:RERANK_TOP_K]

    for idx, rs in scored:
        if 0 <= idx < len(pool):
            pool[idx].rerank_score = rs
    # Reranker may omit some indices (top_k on its side); anything unscored
    # sinks below scored items but keeps cosine as a stable tiebreak.
    ranked_all = sorted(
        pool,
        key=lambda r: (r.rerank_score if r.rerank_score is not None else -1.0, r.score),
        reverse=True,
    )

    kept = ranked_all[:RERANK_TOP_K]
    kept_keys = {r.dedup_key for r in kept}

    # Lecture reserve: guarantee the top RERANK_MIN_LECTURES lectures (by
    # rerank_score) survive, so a lecture-starved cut can't trip a spurious
    # coverage-gate regeneration downstream.
    lectures_in = sum(1 for r in kept if r.kind == "lecture")
    if lectures_in < RERANK_MIN_LECTURES:
        for r in ranked_all:
            if lectures_in >= RERANK_MIN_LECTURES:
                break
            if r.kind == "lecture" and r.dedup_key not in kept_keys:
                kept.append(r)
                kept_keys.add(r.dedup_key)
                lectures_in += 1

    # Per-family reserve for verses and the rest of the library. The cross-
    # encoder favours conversational text and its scores aren't comparable
    # across kinds, so terse verse chunks get 0 of the top-K even when on-topic
    # (observed in prod: 26 verse candidates → 0 kept). Mirror the lecture
    # reserve, gated by a cosine floor so we never force low-relevance junk.
    def _reserve(kind_pred: Callable[[str], bool], minimum: int) -> None:
        have = sum(1 for r in kept if kind_pred(r.kind))
        if have >= minimum:
            return
        for r in ranked_all:
            if have >= minimum:
                break
            if (
                kind_pred(r.kind)
                and r.dedup_key not in kept_keys
                and r.score >= RERANK_RESERVE_FLOOR
            ):
                kept.append(r)
                kept_keys.add(r.dedup_key)
                have += 1

    _reserve(lambda k: k == "verse", RERANK_MIN_VERSES)
    _reserve(lambda k: k in ("commentary", "prose_chapter", "letter"), RERANK_MIN_LIBRARY)

    # Re-sort the final set so reserve additions land in rerank order,
    # not appended at the tail.
    kept.sort(
        key=lambda r: (r.rerank_score if r.rerank_score is not None else -1.0, r.score),
        reverse=True,
    )
    return kept


async def fanout_search_with_boost(
    queries: list[tuple[int, str]],
    *,
    embedder: Any,
    chunk_repo: Any,
    catalog_repo: Any,
    alias_map: Any,
    lang: str | None = None,
    top_k: int = TOPK_PER_QUERY,
    author_id: str | None = None,
    location_id: str | None = None,
    tag_ids: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    book_id: str | None = None,
    on_event: OnEvent | None = None,
    reranker: Any = None,
    rerank_query: str | None = None,
) -> FanoutResult:
    """One round of fanout. Returns top-K envelopes.

    `queries` is a list of `(sub_query_id, text)` tuples. The same
    `sub_query_id` may appear multiple times when the query_planner
    emits `alt_phrasings` (paraphrases that share the parent sub-query).
    Chunks retrieved by a given tuple inherit its `sub_query_id`; on
    cross-tuple collision the higher-score one wins (score-based dedup
    automatically carries the right tag).
    """
    if not queries:
        return FanoutResult()
    k = max(1, min(top_k, 16))
    # Rerank path widens per-sub-query ANN fetch (recall) and drops the
    # 0.45 cosine pre-floor so the cross-encoder can see ~0.30 verses the
    # old floor silently killed. Inactive (reranker is None / no query) ⇒
    # everything below stays on the original cosine path verbatim.
    rerank_active = reranker is not None and bool((rerank_query or "").strip())
    fetch_k = RERANK_FETCH_TOP_K if rerank_active else k

    # 1. Batched embed.
    query_texts = [q[1] for q in queries]
    sub_query_ids = [q[0] for q in queries]
    q_vecs = await embedder.embed_documents(query_texts)
    if len(q_vecs) != len(query_texts):
        log.warning("fanout_embed_mismatch", queries=len(query_texts), vectors=len(q_vecs))
        q_vecs = q_vecs[: len(query_texts)]
        sub_query_ids = sub_query_ids[: len(q_vecs)]

    # 2. Eligible-track filter (catalog-driven; independent of query).
    eligible_track_ids = await catalog_repo.filter_track_ids(
        author_id=author_id, source_id=book_id, location_id=location_id,
        tag_ids=tag_ids, date_from=date_from, date_to=date_to,
    )
    lectures_disabled = eligible_track_ids is not None and not eligible_track_ids

    async def _one_query(q_vec: list[float], q_text: str, sq_id: int) -> list[_RawScored]:
        async def _lecture(use_lang: str | None) -> list[_RawScored]:
            if lectures_disabled:
                return []
            scored = await chunk_repo.search_by_embedding(
                q_vec, eligible_track_ids=eligible_track_ids, lang=use_lang, top_k=fetch_k,
            )
            return [
                _RawScored(s.chunk, s.score, "lecture", _lecture_dedup_key(s.chunk), sq_id)
                for s in scored
            ]

        async def _library(use_lang: str | None, kinds: list[str]) -> list[_RawScored]:
            scored = await chunk_repo.search_library_by_embedding(
                q_vec, kinds=kinds, source_id=book_id, author_id=author_id,
                lang=use_lang, date_from=date_from, date_to=date_to, top_k=fetch_k,
            )
            return [
                _RawScored(s.chunk, s.score, s.chunk.item_kind, _library_dedup_key(s.chunk), sq_id)
                for s in scored
            ]

        async def _lexical(use_lang: str | None) -> list[_RawScored]:
            # Hybrid recall lane: full-text (russian + simple) + trigram address
            # over library chunks — catches addresses / translit / short verses
            # dense cosine misses. Only on the rerank path (the cross-encoder
            # re-scores these on text). Never fails the turn — errors → [].
            if not rerank_active:
                return []
            try:
                scored = await chunk_repo.search_chunks_lexical(
                    q_text, q_vec, kinds=list(_LIBRARY_KINDS),
                    source_id=book_id, author_id=author_id, lang=use_lang,
                    date_from=date_from, date_to=date_to,
                    top_k=LEXICAL_FETCH_TOP_K, trgm_min_sim=LEXICAL_TRGM_MIN_SIM,
                )
            except Exception as exc:  # noqa: BLE001 — lexical must never fail a turn
                log.warning("fanout_lexical_failed", error=str(exc))
                return []
            return [
                _RawScored(
                    s.chunk, s.score, s.chunk.item_kind,
                    _library_dedup_key(s.chunk), sq_id, forced=True,
                )
                for s in scored
            ]

        async def _run(use_lang: str | None) -> list[_RawScored]:
            # Verses fetched in their OWN ANN call (own LIMIT) so short verse
            # chunks aren't starved by long commentary/prose that win the shared
            # cosine top-K. Other library kinds keep one combined fetch. The
            # lexical lane runs alongside (forced members).
            other_lib = [k for k in _LIBRARY_KINDS if k != "verse"]
            lec, verse_lib, rest_lib, lex = await asyncio.gather(
                _lecture(use_lang),
                _library(use_lang, ["verse"]),
                _library(use_lang, other_lib),
                _lexical(use_lang),
            )
            return lec + verse_lib + rest_lib + lex

        rows = await _run(lang)
        if not rows and lang is not None:
            rows = await _run(None)
        # Surface what THIS query touched live, before the global dedup
        # and ranking — the user wants "I'm looking at this now", not
        # "I picked these after thinking". Floor matches the post-dedup
        # filter so we don't stream obvious noise.
        for r in rows:
            if r.score < _RELEVANCE_FLOOR and not r.forced:
                continue
            _emit_research_source(on_event, r)
        return rows

    # 3. Run the parallel fanout queries.
    per_query = list(await asyncio.gather(
        *(
            _one_query(v, txt, sq_id)
            for v, txt, sq_id in zip(q_vecs, query_texts, sub_query_ids)
        )
    ))

    # 3b. Address fast-path. An explicit "БГ 2.13" in the question → exact
    # verse + commentary fetched deterministically. The lexical lane's trgm
    # address match dilutes on a verbose query (it compares the WHOLE query
    # string), so this exact-equality lookup is the robust path. Forced +
    # authoritative score. Rerank-path only (cosine path stays unchanged).
    if rerank_active and rerank_query:
        addr_labels = _parse_addresses(rerank_query)
        if addr_labels:
            async def _address(addr: str) -> list[_RawScored]:
                try:
                    chunks = await chunk_repo.get_chunks_by_addr_label(
                        addr, kinds=["verse", "commentary"], lang=lang,
                    )
                    if not chunks and lang is not None:
                        chunks = await chunk_repo.get_chunks_by_addr_label(
                            addr, kinds=["verse", "commentary"], lang=None,
                        )
                except Exception as exc:  # noqa: BLE001 — never fail a turn
                    log.warning("fanout_address_failed", addr=addr, error=str(exc))
                    return []
                return [
                    _RawScored(
                        c, ADDRESS_HIT_SCORE, c.item_kind,
                        _library_dedup_key(c), None, forced=True,
                    )
                    for c in chunks
                ]
            addr_batches = await asyncio.gather(*(_address(a) for a in addr_labels))
            for batch in addr_batches:
                for r in batch:
                    _emit_research_source(on_event, r)
                per_query.append(batch)

    # 4. Dedup + relevance floor. The rerank path uses a permissive cosine
    # junk-floor instead of 0.45 so the cross-encoder can see the low-cosine
    # verses; the cosine path keeps the 0.45 floor verbatim. Forced (hybrid
    # lexical / address) hits bypass the floor — that's the whole point: they
    # carry a real (often low) cosine and need the cross-encoder to judge them.
    floor = RERANK_NOISE_PREFLOOR if rerank_active else _RELEVANCE_FLOOR
    deduped: dict[tuple, _RawScored] = {}
    for batch in per_query:
        for r in batch:
            if r.score < floor and not r.forced:
                continue
            prev = deduped.get(r.dedup_key)
            if prev is None or prev.score < r.score:
                # Preserve `forced` across the collision: a chunk surfaced by
                # both dense and the lexical lane stays guaranteed into the pool.
                if prev is not None and prev.forced:
                    r.forced = True
                deduped[r.dedup_key] = r
            elif r.forced:
                prev.forced = True

    # 5. Rank. Cosine path: sort by cosine, take top-K (unchanged).
    # Rerank path: pre-cap the pool by cosine, cross-encode it, sort by
    # rerank_score, cut by fixed top-k with a lecture reserve.
    if rerank_active:
        ranked = await _rerank_pool(
            deduped, reranker=reranker, rerank_query=rerank_query,
        )
    else:
        ranked = sorted(deduped.values(), key=lambda r: r.score, reverse=True)[:k]

    # Telemetry: per-kind distribution in the dedup pool (before slicing) vs
    # the top-K. Lets us see when verse-chunks exist in the candidate pool but
    # lose to lectures in ranking — driving reserve/floor tuning with data.
    candidate_by_kind: dict[str, int] = {}
    for r in deduped.values():
        candidate_by_kind[r.kind] = candidate_by_kind.get(r.kind, 0) + 1
    topk_by_kind: dict[str, int] = {}
    for r in ranked:
        topk_by_kind[r.kind] = topk_by_kind.get(r.kind, 0) + 1
    log.info(
        "fanout_kind_distribution",
        candidates_total=len(deduped),
        candidates_by_kind=candidate_by_kind,
        topk_by_kind=topk_by_kind,
    )

    # 6. Envelope (mints aliases) and build by_kind partition.
    envelopes: list[dict[str, Any]] = []
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for r in ranked:
        if r.kind == "lecture":
            env = lecture_to_envelope(
                r.chunk, alias_map=alias_map, score=r.score,
                sub_query_id=r.sub_query_id,
            )
        else:
            env = library_to_envelope(
                r.chunk, alias_map=alias_map, score=r.score,
                sub_query_id=r.sub_query_id,
            )
        # Dual score: cosine `score` set by the envelope builder is left
        # untouched (every coverage / thin-thesis / attribution gate reads
        # it); the cross-encoder relevance rides in a separate field that
        # drives ordering + the final cut only.
        if r.rerank_score is not None:
            env["rerank_score"] = r.rerank_score
        # Add dedup_key to envelope for merge_fanout — caller-private field.
        env["_dedup_key"] = r.dedup_key
        envelopes.append(env)
        by_kind.setdefault(r.kind, []).append(env)

    # max_score stays the max COSINE of the ranked set so the coverage gate
    # keeps its tuned semantics (the top-reranked item isn't necessarily the
    # top-cosine one).
    max_score = max((r.score for r in ranked), default=0.0)
    return FanoutResult(
        chunks=envelopes,
        by_kind=by_kind,
        max_score=max_score,
        rounds_executed=1,
    )


def _order_key(env: dict[str, Any]) -> float:
    """Ordering score: rerank_score when present (reranked chunks),
    falling back to cosine `score` (reranker off, or refs that never went
    through rerank). Keeps the rerank order from being undone by a cosine
    re-sort."""
    rs = env.get("rerank_score")
    if rs is not None:
        return rs
    return env.get("score") or 0.0


def merge_fanout(a: FanoutResult, b: FanoutResult) -> FanoutResult:
    """Merge two rounds. Dedup on the internal `_dedup_key` field added by
    `fanout_search_with_boost`; keep the higher cosine score on conflicts;
    order the merged list by rerank_score (fallback cosine `score`).

    `max_score` stays the max COSINE so the coverage gate's scale-tuned
    thresholds keep reading the value they were calibrated against."""
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
    merged = sorted(by_key.values(), key=_order_key, reverse=True)
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for env in merged:
        by_kind.setdefault(env.get("type") or "unknown", []).append(env)
    return FanoutResult(
        chunks=merged,
        by_kind=by_kind,
        max_score=max((e.get("score") or 0.0 for e in merged), default=0.0),
        rounds_executed=max(a.rounds_executed, b.rounds_executed),
    )
