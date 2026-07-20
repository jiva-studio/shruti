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
import time
from dataclasses import dataclass
from typing import Any, Callable

from shruti_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
    resolve_commentary_author_names,
)
from shruti_chat.agent.tools._helpers import BOOK_PREFIX
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.constants import (
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
from shruti_chat.research.models import FanoutResult


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


def _fmt_timecode(ms: Any) -> str:
    """`start_ms` → "m:ss" (or "h:mm:ss" past the hour) for the panel chip."""
    total = max(0, int(ms or 0)) // 1000
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _label_for_lecture_chunk(c: Any, title: str | None) -> str | None:
    """Panel label for a lecture chunk: lecture title + a timecode
    (e.g. "Утренняя прогулка · 12:04"). The raw transcript snippet we used
    before was opaque and noisy; title+timecode is what orients the user.

    Returns None when the title can't be resolved — a bare timecode is
    meaningless and the panel is purely visual, so we'd rather drop the
    source than show a chip with no context (same "normalize or drop" rule
    `_label_for_library_chunk` follows)."""
    title = (title or "").strip()
    if not title:
        return None
    return f"{title} · {_fmt_timecode(getattr(c, 'start_ms', 0))}"


def _label_for_library_chunk(c: Any) -> str | None:
    """Human-readable label for a library chunk's pill in the chat status.

    Order of preference:
      1. `addr_label` produced by the indexer (e.g. "BG 2.13",
         "Letter to Brahmananda, 1972-10-04") — the canonical short form.
      2. Compose `source_id + tokens` when addr_label was lost — same
         pattern `_verse_addr` uses in the indexer, so e.g. a verse with
         source_id="BG" and tokens="2.13" renders as "BG 2.13".
      3. `doc_date` for letters with no source/tokens.

    Returns None when none of those produce a real address. We deliberately
    DON'T fall back to a generic "verse" / "library document" string: the
    panel is purely visual and a generic chip is just noise (and, before
    this, a recurring source of the bare "verse" pill — the placeholder for
    a ref whose real addr_label never landed). Better blank than generic.
    Never the raw `item_id` (issue #660)."""
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
    if item_kind == "letter" and doc_date:
        return f"Letter, {doc_date}"
    return None


def emit_library_research_source(
    on_event: OnEvent | None, *, item_kind: str, chunk: Any,
) -> None:
    """Emit a normalized `research_source` for a verse / commentary /
    prose_chapter / letter chunk, or nothing if its label can't be
    normalized (drop — see `_label_for_library_chunk`).

    Verse → `kind="verse"`, `id="verse:<item_id>"`. Media clip →
    `kind="media"`, `id="media:<item_id>"` (its own panel namespace — the
    card renders a player, not a doc tile). Every other library kind →
    `kind="library_doc"`, `id="library:<item_id>"` (the panel doesn't
    distinguish them). The `library:<item_id>` namespace is shared with the
    attribution-refs path in pipeline.py so the client's dedup-by-id collapses
    a doc discovered through both code paths. Shared by the fanout and the
    attribution-ref fetch so both surface the same normalized label."""
    if on_event is None:
        return
    label = _label_for_library_chunk(chunk)
    if not label:
        return
    item_id = getattr(chunk, "item_id", "")
    if item_kind == "verse":
        kind, source_id = "verse", f"verse:{item_id}"
    elif item_kind == "media":
        kind, source_id = "media", f"media:{item_id}"
    else:
        kind, source_id = "library_doc", f"library:{item_id}"
    try:
        on_event("research_source", {"kind": kind, "id": source_id, "label": label})
    except Exception:  # noqa: BLE001 — observability must never break research
        log.warning("on_event_research_source_failed", kind=item_kind)


def _emit_research_source(
    on_event: OnEvent | None,
    r: "_RawScored",
    *,
    lecture_titles: dict[str, str] | None = None,
) -> None:
    """Surface one inspected source live, BEFORE dedup/boost/sort. The
    client dedups by `id` on its side. A source whose label can't be
    normalized is dropped (no event)."""
    if on_event is None:
        return
    chunk = r.chunk
    if r.kind != "lecture":
        emit_library_research_source(on_event, item_kind=r.kind, chunk=chunk)
        return
    title = (lecture_titles or {}).get(getattr(chunk, "track_id", ""))
    label = _label_for_lecture_chunk(chunk, title)
    if not label:
        return
    track_id = getattr(chunk, "track_id", "")
    start_ms = getattr(chunk, "start_ms", 0)
    try:
        on_event(
            "research_source",
            {
                "kind": "lecture_chunk",
                "id": f"lecture:{track_id}:{start_ms}",
                "label": label,
            },
        )
    except Exception:  # noqa: BLE001 — observability must never break fanout
        log.warning("on_event_research_source_failed", kind=r.kind)


log = get_logger(__name__)


_LIBRARY_KINDS = ("verse", "commentary", "prose_chapter", "letter", "media")
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
    kind: str           # "lecture" | "verse" | "commentary" | "prose_chapter" | "letter" | "media"
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


# Additive nudge to the rerank SORT KEY for a content kind the user explicitly
# asked for ("покажи видео…" → media, "…с пурпортами" → commentary/verse). Gated
# on an explicit request (boost_kinds is empty otherwise), ordering-only — the
# cosine `score` that feeds the coverage gate is never touched, so retrieval
# breadth stays honest. Magnitude is intentionally modest; calibrate via probe.
KIND_BOOST_DELTA = 0.15
# Guarantee at least this many of an explicitly-requested kind survive the cut
# (so the planner actually SEES the clips, not just ranks them).
RERANK_MIN_BOOST = 3


def _rank_key(r: "_RawScored", boost_kinds: frozenset[str]) -> tuple[float, float]:
    base = r.rerank_score if r.rerank_score is not None else -1.0
    if boost_kinds and r.kind in boost_kinds:
        base += KIND_BOOST_DELTA
    return (base, r.score)


async def _rerank_pool(
    deduped: dict[tuple, _RawScored],
    *,
    reranker: Any,
    rerank_query: str | None,
    boost_kinds: frozenset[str] = frozenset(),
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
        key=lambda r: _rank_key(r, boost_kinds),
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
    # Reserve for an explicitly-requested kind — so e.g. "show me video" can't
    # have its clips crowded out of the cut by higher-scored letters.
    if boost_kinds:
        _reserve(lambda k: k in boost_kinds, RERANK_MIN_BOOST)

    # Re-sort the final set so reserve additions land in rerank order
    # (incl. the boost nudge), not appended at the tail.
    kept.sort(
        key=lambda r: _rank_key(r, boost_kinds),
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
    boost_kinds: frozenset[str] = frozenset(),
    owned_track_ids: list[str] | None = None,
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

    # 1. Batched embed ∥ eligible-track filter. The catalog-driven filter is
    # independent of the query embedding, so overlap the two round-trips
    # (OpenRouter embed + catalog query) instead of paying their sum before
    # the per-query fanout.
    query_texts = [q[1] for q in queries]
    sub_query_ids = [q[0] for q in queries]
    # Sub-stage timings — the whole round is one opaque `fanout_round_N`
    # stage upstream; this breaks it into embed / ANN / address / rerank so
    # a single trace shows whether the cost is pgvector ANN or the remote
    # cross-encoder. Logged once as `fanout_round_breakdown` at the end.
    _t_embed = time.perf_counter()
    q_vecs, eligible_track_ids = await asyncio.gather(
        # QUERY text → query embed path (applies the query prefix, not the
        # doc prefix); essential the moment an asymmetric model is enabled.
        embedder.embed_queries(query_texts),
        catalog_repo.filter_track_ids(
            author_id=author_id, source_id=book_id, location_id=location_id,
            tag_ids=tag_ids, date_from=date_from, date_to=date_to,
        ),
    )
    embed_ms = (time.perf_counter() - _t_embed) * 1000.0
    if len(q_vecs) != len(query_texts):
        log.warning("fanout_embed_mismatch", queries=len(query_texts), vectors=len(q_vecs))
        # Truncate ALL THREE parallel lists to the common length. Slicing
        # q_vecs/sub_query_ids alone left query_texts at full length, so the
        # downstream `zip(q_vecs, query_texts, sub_query_ids)` silently dropped
        # whichever tail sub-queries the embedder returned vectors for.
        n = min(len(q_vecs), len(query_texts), len(sub_query_ids))
        q_vecs = q_vecs[:n]
        query_texts = query_texts[:n]
        sub_query_ids = sub_query_ids[:n]

    # 2. Lecture lane is disabled when the catalog filter matched zero tracks.
    lectures_disabled = eligible_track_ids is not None and not eligible_track_ids

    # Per-lane ANN timing. The 4 lanes run concurrently inside `_run` across
    # all sub-queries, so the round's `ann_ms` is bounded by the slowest single
    # lane call — recording each call's duration (incl. the `lang=None` fallback
    # re-run, and lexical even when it errors) lets one trace point at the
    # culprit lane. Suspect: the lexical trigram/FTS lane on a large table.
    # Single-threaded asyncio ⇒ list.append needs no lock.
    lane_ms: dict[str, list[float]] = {}

    def _record(lane: str, started: float) -> None:
        lane_ms.setdefault(lane, []).append((time.perf_counter() - started) * 1000.0)

    async def _one_query(q_vec: list[float], q_text: str, sq_id: int) -> list[_RawScored]:
        async def _lecture(use_lang: str | None) -> list[_RawScored]:
            if lectures_disabled:
                return []
            _t = time.perf_counter()
            scored = await chunk_repo.search_by_embedding(
                q_vec, eligible_track_ids=eligible_track_ids, lang=use_lang, top_k=fetch_k,
            )
            _record("lecture", _t)
            return [
                _RawScored(s.chunk, s.score, "lecture", _lecture_dedup_key(s.chunk), sq_id)
                for s in scored
            ]

        async def _user_lecture(use_lang: str | None) -> list[_RawScored]:
            # Private per-user lane (#1227): the SAME lecture retrieval, but
            # over `kind='user_track'` chunks restricted to the tracks THIS
            # user owns (ACL from the server-side `owned` table, passed in as
            # `owned_track_ids`). Off entirely when the user owns nothing, so
            # a signed-out / library-less turn pays zero extra ANN cost and
            # the public corpus behaviour is byte-for-byte unchanged.
            if not owned_track_ids:
                return []
            _t = time.perf_counter()
            scored = await chunk_repo.search_by_embedding(
                q_vec,
                eligible_track_ids=owned_track_ids,
                lang=use_lang,
                top_k=fetch_k,
                kind="user_track",
            )
            _record("user_lecture", _t)
            # Surfaced under the same "lecture" kind so private results merge
            # into the lecture dedup / ranking / citation path identically to
            # corpus lectures — the isolation lives in the ACL + kind filter,
            # not in a separate downstream branch.
            return [
                _RawScored(s.chunk, s.score, "lecture", _lecture_dedup_key(s.chunk), sq_id)
                for s in scored
            ]

        async def _library(use_lang: str | None, kinds: list[str]) -> list[_RawScored]:
            _t = time.perf_counter()
            scored = await chunk_repo.search_library_by_embedding(
                q_vec, kinds=kinds, source_id=book_id, author_id=author_id,
                lang=use_lang, date_from=date_from, date_to=date_to, top_k=fetch_k,
            )
            _record("library_verse" if kinds == ["verse"] else "library_rest", _t)
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
            _t = time.perf_counter()
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
            finally:
                # Record even on failure — a slow-then-timeout lexical lane is
                # exactly the spike we're hunting.
                _record("lexical", _t)
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
            lec, usr_lec, verse_lib, rest_lib, lex = await asyncio.gather(
                _lecture(use_lang),
                _user_lecture(use_lang),
                _library(use_lang, ["verse"]),
                _library(use_lang, other_lib),
                _lexical(use_lang),
            )
            return lec + usr_lec + verse_lib + rest_lib + lex

        # Search ONLY the requested language. Retrieved chunks are surfaced to
        # the user verbatim (cited, never LLM-rewritten/translated), so a
        # cross-language fallback would hand e.g. an English transcript to a
        # Russian user — useless. Honouring lang strictly also lets the lecture
        # lane use the per-(kind,lang) composite HNSW index (migration 0036)
        # exclusively, so the redundant kind-only `_hnsw_lec` can be dropped.
        rows = await _run(lang)
        # Surface what THIS query touched live, before the global dedup
        # and ranking — the user wants "I'm looking at this now", not
        # "I picked these after thinking". Floor matches the post-dedup
        # filter so we don't stream obvious noise.
        surfaced = [r for r in rows if r.score >= _RELEVANCE_FLOOR or r.forced]
        # Lecture panel chips read "title · timecode"; the chunk carries no
        # title, so batch-resolve it for the lectures we're about to surface.
        # Best-effort — a missing resolver / failure just drops lecture chips.
        lecture_titles: dict[str, str] = {}
        if on_event is not None:
            lec_ids = list({
                getattr(r.chunk, "track_id", "")
                for r in surfaced
                if r.kind == "lecture" and getattr(r.chunk, "track_id", "")
            })
            get_titles = getattr(catalog_repo, "get_titles", None)
            if lec_ids and get_titles is not None:
                try:
                    lecture_titles = await get_titles(lec_ids, lang=lang)
                except Exception as exc:  # noqa: BLE001 — never fail a turn
                    log.warning("fanout_get_titles_failed", error=str(exc))
        for r in surfaced:
            _emit_research_source(on_event, r, lecture_titles=lecture_titles)
        return rows

    # 3. Run the parallel fanout queries.
    _t_ann = time.perf_counter()
    per_query = list(await asyncio.gather(
        *(
            _one_query(v, txt, sq_id)
            for v, txt, sq_id in zip(q_vecs, query_texts, sub_query_ids)
        )
    ))
    ann_ms = (time.perf_counter() - _t_ann) * 1000.0

    # 3b. Address fast-path. An explicit "БГ 2.13" in the question → exact
    # verse + commentary fetched deterministically. The lexical lane's trgm
    # address match dilutes on a verbose query (it compares the WHOLE query
    # string), so this exact-equality lookup is the robust path. Forced +
    # authoritative score. Rerank-path only (cosine path stays unchanged).
    addr_ms = 0.0
    if rerank_active and rerank_query:
        addr_labels = _parse_addresses(rerank_query)
        if addr_labels:
            _t_addr = time.perf_counter()
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
            addr_ms = (time.perf_counter() - _t_addr) * 1000.0

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
    rerank_ms = 0.0
    if rerank_active:
        _t_rerank = time.perf_counter()
        ranked = await _rerank_pool(
            deduped, reranker=reranker, rerank_query=rerank_query,
            boost_kinds=boost_kinds,
        )
        rerank_ms = (time.perf_counter() - _t_rerank) * 1000.0
    else:
        ranked = sorted(deduped.values(), key=lambda r: r.score, reverse=True)[:k]

    # Sub-stage breakdown of this fanout round (embed ∥ track-filter, then
    # ANN fanout, address fast-path, cross-encoder rerank). Pairs with the
    # `fanout_round_N` stage_timing total to attribute the 11-30s round cost.
    # `lane` splits the concurrent ANN fanout per lane — n / max / sum (ms) —
    # so the slowest lane (bounding the round) is visible in one trace.
    lane_breakdown = {
        lane: {"n": len(v), "max_ms": round(max(v), 1), "sum_ms": round(sum(v), 1)}
        for lane, v in sorted(lane_ms.items())
    }
    log.info(
        "fanout_round_breakdown",
        n_subqueries=len(query_texts),
        candidates_total=len(deduped),
        embed_ms=round(embed_ms, 1),
        ann_ms=round(ann_ms, 1),
        addr_ms=round(addr_ms, 1),
        rerank_ms=round(rerank_ms, 1),
        lane=lane_breakdown,
    )

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
    # Batch-resolve commentary author names up front so a purport surfaced by
    # fanout cites with a real author ("А.Ч. Прабхупада, ШБ 4.1.39"), not a
    # bare address — same lookup the SHORT-path commentary_expansion already
    # does. Best-effort: empty map if no catalog/lang, envelope falls back to
    # the address alone.
    library_chunks = [r.chunk for r in ranked if r.kind != "lecture"]
    author_names = await resolve_commentary_author_names(
        library_chunks, catalog_repo=catalog_repo, lang=lang,
    )
    envelopes: list[dict[str, Any]] = []
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for r in ranked:
        if r.kind == "lecture":
            env = lecture_to_envelope(
                r.chunk, alias_map=alias_map, score=r.score,
                sub_query_id=r.sub_query_id,
            )
        else:
            author_name = (
                author_names.get(r.chunk.author_id) if getattr(r.chunk, "author_id", None) else None
            )
            env = library_to_envelope(
                r.chunk, alias_map=alias_map, score=r.score,
                sub_query_id=r.sub_query_id,
                extra_meta={"author_name": author_name} if author_name else None,
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


def dedup_notes_by_key(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse a flat note list so each unique source `_dedup_key`
    ((item_kind, item_id, segment_index) for library / media, ("lecture",
    track_id, start_ms, end_ms) for lectures) appears at most ONCE.

    Keeps the FIRST occurrence of each key, preserving the incoming order
    (which is already meaningful — authoritative-then-ranked). Aliases are
    minted at envelope-build time, so a later duplicate carries a second,
    orphaned alias; dropping the duplicate note here means the synthesizer
    never sees it and so can't cite the same clip twice. This is the single
    global guard run on the final assembled note set, BEFORE the synthesizer
    (and the synthesis planner) reads it.

    Notes without a `_dedup_key` (history echoes, ad-hoc tool results) are
    passed through untouched — we can't key them, and they're never the
    source of the media double-cite this guards against."""
    seen: set[tuple] = set()
    out: list[dict[str, Any]] = []
    for env in notes:
        key = env.get("_dedup_key") if isinstance(env, dict) else None
        if key is None:
            out.append(env)
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append(env)
    return out


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
