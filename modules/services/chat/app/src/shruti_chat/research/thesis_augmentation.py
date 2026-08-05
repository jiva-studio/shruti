"""thesis_augmentation — Stage 2 of the per-thesis relevance pipeline.

After Stage 1 (`rerank_and_attach_commentaries`) has rewritten each
thesis's `supporting_notes` by cosine, some theses may still be thin —
their best supporting note has a weak cosine, or fewer than two notes
clear the threshold. This usually means the planner formed a thesis
the initial fanout didn't fully cover (e.g. a conclusion-style thesis
that crosses sub-queries, or a thesis spotting an angle the seed
sub-queries missed).

CRAG-style remedy: for each thin thesis, run ONE thesis-targeted ANN
search across lectures + library kinds, merge the fresh chunks into a
per-thesis pool, re-cosine, pick new top-K.

Conservative by design — fires per-thesis only when needed, never
chains (one augmentation round, then we settle for what we have).
"""

from __future__ import annotations

import asyncio
from typing import Any

from shruti_chat.agent.tools._envelope import (
    _AUTHORED_KINDS,
    lecture_to_envelope,
    library_to_envelope,
    resolve_commentary_author_names,
)
from shruti_chat.domain.source_ids import chunk_source_filter
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.commentary_expansion import _balanced_topk, _cosine
from shruti_chat.research.constants import (
    AUGMENT_FRESH_TOP_K,
    THIN_THESIS_MIN_SCORE,
    THIN_THESIS_MIN_STRONG_NOTES,
)


log = get_logger(__name__)


_LIBRARY_KINDS = ("verse", "commentary", "prose_chapter", "letter", "media")


def _is_thin(scored: list[tuple[float, int]]) -> bool:
    """A thesis is thin when its current top scored note has cosine
    below the floor, OR fewer than the required count clear it.

    `scored` is a sorted-descending list of `(cosine, pool_idx)` for the
    thesis's current supporting_notes.
    """
    if not scored:
        return True
    if scored[0][0] < THIN_THESIS_MIN_SCORE:
        return True
    strong = sum(1 for s, _ in scored if s >= THIN_THESIS_MIN_SCORE)
    return strong < THIN_THESIS_MIN_STRONG_NOTES


def _as_ids(author_id: Any) -> list[str] | None:
    """One author from the router's args as the set the port now takes."""
    return [author_id] if isinstance(author_id, str) and author_id else None


async def _fresh_fanout_for_thesis(
    thesis_embedding: list[float],
    *,
    chunk_repo: Any,
    catalog_repo: Any,
    router_args: dict[str, Any],
    lang: str | None,
    top_k: int,
    author_scope: Any | None = None,
) -> tuple[list[Any], list[Any]]:
    """Single thesis-targeted ANN fetch. Mirrors `fanout_search_with_boost`'s
    inner per-query call but skips the boost / dedup / multi-query
    machinery — we're augmenting one thesis with one focused query.

    Respects the user's router_args filters (author / location / date / tag)
    so augmentation can't smuggle in chunks outside their intent.
    """
    eligible = await catalog_repo.filter_track_ids(
        author_ids=_as_ids(router_args.get("author_id")),
        source_id=router_args.get("source_id"),
        location_id=router_args.get("location_id"),
        tag_ids=router_args.get("tag_ids"),
        date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
        date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
    )
    if author_scope is not None:
        eligible = await author_scope.narrow(eligible)
    lectures_disabled = eligible is not None and not eligible

    async def _lectures() -> list[Any]:
        if lectures_disabled:
            return []
        scored = await chunk_repo.search_by_embedding(
            thesis_embedding,
            eligible_track_ids=eligible,
            lang=lang,
            top_k=top_k,
        )
        return list(scored)

    async def _library() -> list[Any]:
        scored = await chunk_repo.search_library_by_embedding(
            thesis_embedding,
            kinds=list(_LIBRARY_KINDS),
            # Chunk-side spelling only — a short code here matches no row at all
            # (see `domain.source_ids`); the track filter above resolves its own.
            source_id=chunk_source_filter(router_args.get("source_id")),
            author_id=router_args.get("author_id"),
            lang=lang,
            date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
            date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
            top_k=top_k,
        )
        return list(scored)

    lec, lib = await asyncio.gather(_lectures(), _library())
    return lec, lib


async def augment_thin_theses(
    outline: Any,                       # Outline
    base_notes: list[dict[str, Any]],   # current tool_results (base + Stage 1 commentaries)
    *,
    chunk_repo: Any,
    embedder: Any,
    alias_map: Any,
    catalog_repo: Any,
    lang: str | None,
    router_args: dict[str, Any] | None = None,
    top_k_per_thesis: int = 5,
    fresh_top_k: int = AUGMENT_FRESH_TOP_K,
    reranker: Any = None,
    user_query: str | None = None,
    # The turn's author selection: the per-thesis top-up is lecture retrieval
    # like any other, so it narrows too. The library top-up below does not.
    author_scope: Any | None = None,
) -> tuple[Any, list[dict[str, Any]]]:
    """Stage 2 — for each thin thesis, do a fresh thesis-targeted ANN
    fetch + re-rank.

    Returns `(enriched_outline, additional_chunks)`. Caller appends
    `additional_chunks` to LangGraph state's `tool_results` (append
    reducer) and writes `enriched_outline` back.

    Graceful degrade: any exception or missing collaborator returns the
    input outline + [] — Stage 1's picks survive unchanged.
    """
    # Local import to avoid models <-> augmentation circular deps.
    from shruti_chat.research.models import Outline, Thesis

    if (
        not isinstance(outline, Outline)
        or not outline.theses
        or embedder is None
        or chunk_repo is None
        or catalog_repo is None
    ):
        return outline, []

    router_args = router_args or {}

    # ── 1. Embed the theses AND their current supporting-note texts ─────
    # Both feed the cosine-scoring below and are independent, so embed them
    # CONCURRENTLY — previously the two `embed_documents` calls ran serially,
    # stacking ~one extra embed round-trip onto the post-planner critical
    # path. Only notes that some thesis actually references are embedded
    # (skips the cost on notes no thesis cares about).
    thesis_texts = [t.thesis for t in outline.theses]
    referenced_indices: set[int] = set()
    for t in outline.theses:
        for idx in t.supporting_notes:
            if 1 <= idx <= len(base_notes):
                referenced_indices.add(idx)
    ref_idx_list = sorted(referenced_indices)
    ref_texts = [(base_notes[i - 1].get("text") or "").strip() for i in ref_idx_list]
    nonempty_refs = [(idx, txt) for idx, txt in zip(ref_idx_list, ref_texts) if txt]

    async def _embed_q(texts: list[str]) -> list[list[float]]:
        # Theses are QUERIES (used as the ANN query vector below) → query path.
        return await embedder.embed_queries(texts) if texts else []

    async def _embed_d(texts: list[str]) -> list[list[float]]:
        # Notes are DOCUMENTS scored against the thesis → document path.
        return await embedder.embed_documents(texts) if texts else []

    try:
        thesis_embeds, ref_embeds = await asyncio.gather(
            _embed_q(thesis_texts),
            _embed_d([t for _, t in nonempty_refs]),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("augment_embed_failed", error=str(exc))
        return outline, []

    if len(thesis_embeds) != len(thesis_texts):
        log.warning(
            "augment_thesis_embed_count_mismatch",
            expected=len(thesis_texts),
            got=len(thesis_embeds),
        )
        return outline, []

    # ── 2. Score each thesis's CURRENT supporting_notes by cosine ───────
    note_embed_by_idx: dict[int, list[float]] = {}
    for (idx, _), emb in zip(nonempty_refs, ref_embeds):
        note_embed_by_idx[idx] = emb

    # Score current support per thesis.
    per_thesis_scored: list[list[tuple[float, int]]] = []
    for t, t_emb in zip(outline.theses, thesis_embeds):
        scored = []
        for idx in t.supporting_notes:
            n_emb = note_embed_by_idx.get(idx)
            if n_emb is None:
                continue
            scored.append((_cosine(t_emb, n_emb), idx))
        scored.sort(reverse=True)
        per_thesis_scored.append(scored)

    # ── 3. Identify thin theses; skip if all are already strong ─────────
    thin_indices = [i for i, s in enumerate(per_thesis_scored) if _is_thin(s)]
    if not thin_indices:
        log.info(
            "augment_skip_all_theses_strong",
            n_theses=len(outline.theses),
        )
        return outline, []

    # ── 4. For each thin thesis: fresh ANN, re-rank ─────────────────────
    # Fresh-fetched chunks accumulate here. Same chunk fetched by two
    # different thin theses gets dedup'd by track_id+window or item_id+seg.
    additional_envelopes: list[dict[str, Any]] = []
    # Seed with every source ALREADY in base_notes so a fresh fetch can't
    # re-mint an alias for a clip the research worker already surfaced. The
    # `_augment_dedup` keys built below share the `_dedup_key` shape
    # ((item_kind, item_id, segment_index) for library/media, ("lecture",
    # track_id, start_ms, end_ms) for lectures), so seeding with base_notes'
    # `_dedup_key` makes a duplicate fetch fall into the existing-index reuse
    # branch instead of minting a second alias. This is the mint-time guard
    # against the media double-cite (one clip → two `[^N]`); the
    # dedup_notes_by_key pass downstream is the belt-and-braces net.
    dedup_seen: set[tuple] = {
        n.get("_dedup_key")
        for n in base_notes
        if isinstance(n, dict) and n.get("_dedup_key") is not None
    }

    next_pool_idx = len(base_notes) + 1  # 1-based; new chunks get this index

    # ── 4a. Fresh ANN for ALL thin theses CONCURRENTLY ──────────────────
    # Previously a serial per-thesis loop (fetch → embed → rerank, each
    # awaited in turn); on turns with 2-3 thin theses that stacked 3× the
    # network round-trips end to end — the dominant post-planner latency.
    # Now: fan the fresh fetches out at once, assign indices in a
    # deterministic serial pass (cross-thesis dedup + next_pool_idx order
    # MUST stay reproducible), batch the embed into ONE call, and fan the
    # per-thesis re-ranks out concurrently. Selection logic below is
    # unchanged — only the I/O scheduling differs.
    async def _fetch_for(i: int):
        try:
            lec_scored, lib_scored = await _fresh_fanout_for_thesis(
                thesis_embeds[i],
                chunk_repo=chunk_repo,
                catalog_repo=catalog_repo,
                router_args=router_args,
                lang=lang,
                top_k=fresh_top_k,
                author_scope=author_scope,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("augment_fresh_fetch_failed", thesis_idx=i, error=str(exc))
            return None
        # Resolve human author names for fresh library chunks so an
        # augmentation-fetched commentary / prose / letter carries its
        # attribution (else the synthesizer blockquote renders address-only).
        lib_author_names = await resolve_commentary_author_names(
            [s.chunk for s in lib_scored], catalog_repo=catalog_repo, lang=lang,
        )
        return lec_scored, lib_scored, lib_author_names

    fetched = await asyncio.gather(*(_fetch_for(i) for i in thin_indices))
    fetch_by_thesis: dict[int, Any] = dict(zip(thin_indices, fetched))
    fetch_failed: set[int] = {i for i in thin_indices if fetch_by_thesis.get(i) is None}

    # ── 4b. Deterministic serial pass: dedup + 1-based index assignment ─
    # Order = thin_indices order, lectures before library per thesis —
    # identical append order to the old serial loop, so a given corpus
    # produces the same indices either way. CPU-only; no awaits.
    fresh_by_thesis: dict[int, list[tuple[int, dict[str, Any]]]] = {}

    def _existing_idx(key: tuple) -> int | None:
        return next(
            (n + len(base_notes) + 1 for n, env in enumerate(additional_envelopes)
             if env.get("_augment_dedup") == key),
            None,
        )

    for i in thin_indices:
        res = fetch_by_thesis.get(i)
        if res is None:
            fresh_by_thesis[i] = []
            continue
        lec_scored, lib_scored, lib_author_names = res
        fresh_for_this_thesis: list[tuple[int, dict[str, Any]]] = []
        for s in lec_scored:
            chunk = s.chunk
            key = ("lecture", chunk.track_id, chunk.start_ms, chunk.end_ms)
            if key in dedup_seen:
                # Already in base_notes or fetched by an earlier thin thesis.
                existing = _existing_idx(key)
                if existing is not None:
                    fresh_for_this_thesis.append((existing, additional_envelopes[existing - len(base_notes) - 1]))
                continue
            dedup_seen.add(key)
            env = lecture_to_envelope(chunk, alias_map=alias_map, score=s.score)
            env["_augment_dedup"] = key  # for cross-thesis dedup
            additional_envelopes.append(env)
            fresh_for_this_thesis.append((next_pool_idx, env))
            next_pool_idx += 1
        for s in lib_scored:
            chunk = s.chunk
            key = (chunk.item_kind, chunk.item_id, chunk.segment_index or 0)
            if key in dedup_seen:
                existing = _existing_idx(key)
                if existing is not None:
                    fresh_for_this_thesis.append((existing, additional_envelopes[existing - len(base_notes) - 1]))
                continue
            dedup_seen.add(key)
            extra = None
            if chunk.item_kind in _AUTHORED_KINDS and chunk.author_id:
                name = lib_author_names.get(chunk.author_id)
                if name:
                    extra = {"author_name": name}
            env = library_to_envelope(
                chunk, alias_map=alias_map, score=s.score, extra_meta=extra,
            )
            env["_augment_dedup"] = key
            additional_envelopes.append(env)
            fresh_for_this_thesis.append((next_pool_idx, env))
            next_pool_idx += 1
        fresh_by_thesis[i] = fresh_for_this_thesis

    # ── 4c. Embed every fresh envelope ONCE (batched) ───────────────────
    # One embed call for the whole fresh pool instead of one per thesis; a
    # chunk shared by two theses is embedded a single time.
    fresh_emb_by_idx: dict[int, list[float]] = {}
    fresh_pairs = [
        (n + len(base_notes) + 1, (env.get("text") or "").strip())
        for n, env in enumerate(additional_envelopes)
    ]
    fresh_pairs = [(idx, txt) for idx, txt in fresh_pairs if txt]
    if fresh_pairs:
        try:
            fresh_embeds = await embedder.embed_documents([txt for _, txt in fresh_pairs])
        except Exception as exc:  # noqa: BLE001
            log.warning("augment_fresh_embed_failed", error=str(exc))
            fresh_embeds = []
        if len(fresh_embeds) == len(fresh_pairs):
            for (idx, _), f_emb in zip(fresh_pairs, fresh_embeds):
                fresh_emb_by_idx[idx] = f_emb

    # `additional_envelopes` now holds every fresh chunk, so base_notes +
    # additional_envelopes covers all pool indices for the balanced cut.
    pool_for_pick = list(base_notes) + list(additional_envelopes)

    # ── 4d. Re-rank each thin thesis CONCURRENTLY ───────────────────────
    async def _rerank_for(i: int) -> tuple[list[tuple[float, int]], list[int]]:
        t = outline.theses[i]
        fresh = fresh_by_thesis.get(i, [])
        # Re-cosine: pool = current supporting_notes (already scored) +
        # fresh chunks (scored from the batched embeddings above).
        rescored: list[tuple[float, int]] = list(per_thesis_scored[i])
        for idx, _env in fresh:
            f_emb = fresh_emb_by_idx.get(idx)
            if f_emb is not None:
                rescored.append((_cosine(thesis_embeds[i], f_emb), idx))
        rescored.sort(reverse=True)
        cosine_order = [idx for _, idx in rescored]

        # Cross-encoder ORDERS the same pool against the CLAIM (user query +
        # thesis) — query-aware. Any failure ⇒ keep the cosine order. The
        # reranker only re-orders; the balanced cut makes the selection.
        ordered = cosine_order
        if reranker is not None:
            fresh_map = {j: e for j, e in fresh}
            pool_idx = list(cosine_order)
            pool_texts: list[str] = []
            for idx in pool_idx:
                if 1 <= idx <= len(base_notes):
                    txt = (base_notes[idx - 1].get("text") or "").strip()
                else:
                    env = fresh_map.get(idx)
                    txt = (env.get("text") or "").strip() if env else ""
                pool_texts.append(txt)
            rerankable = [(idx, txt) for idx, txt in zip(pool_idx, pool_texts) if txt]
            claim = f"{user_query}\n{t.thesis}" if user_query else t.thesis
            if len(rerankable) >= 2 and claim.strip():
                try:
                    scored_rr = await reranker.rerank(
                        claim, [txt for _, txt in rerankable],
                        top_k=len(rerankable),
                    )
                except Exception as exc:  # noqa: BLE001 — never fail a turn
                    log.warning("augment_rerank_failed", thesis_idx=i, error=str(exc))
                    scored_rr = None
                if scored_rr:
                    rr_order = [
                        rerankable[j][0] for j, _ in scored_rr
                        if 0 <= j < len(rerankable)
                    ]
                    # Keep membership stable — append reranker-dropped notes
                    # (empty-text notes weren't sent to it).
                    for idx in pool_idx:
                        if idx not in rr_order:
                            rr_order.append(idx)
                    ordered = rr_order

        cos_map = {idx: s for s, idx in rescored}
        new_top = _balanced_topk(
            ordered, pool_for_pick, k=top_k_per_thesis,
            score_of=lambda i: cos_map.get(i, 0.0),
        )
        # Defensive: never let augment empty out a thesis.
        if not new_top:
            new_top = list(t.supporting_notes)
        return rescored, new_top

    rerank_targets = [i for i in thin_indices if i not in fetch_failed]
    rerank_results = await asyncio.gather(*(_rerank_for(i) for i in rerank_targets))
    rerank_by_thesis = dict(zip(rerank_targets, rerank_results))

    # ── 4e. Assemble theses (in order) + per-thesis summary ─────────────
    new_theses: list[Thesis] = []
    per_thesis_summary: list[dict] = []
    for i, t in enumerate(outline.theses):
        old_top = per_thesis_scored[i][0][0] if per_thesis_scored[i] else 0.0
        if i not in thin_indices:
            # Strong thesis — passthrough Stage 1's supporting_notes.
            new_theses.append(t)
            per_thesis_summary.append({
                "idx": i, "was_thin": False,
                "old_top_cosine": round(old_top, 3),
                "new_top_cosine": round(old_top, 3),
                "fresh_fetched": 0, "fresh_above_threshold": 0,
            })
            continue
        if i in fetch_failed:
            new_theses.append(t)
            per_thesis_summary.append({
                "idx": i, "was_thin": True,
                "old_top_cosine": round(old_top, 3),
                "new_top_cosine": round(old_top, 3),
                "fresh_fetched": 0, "fresh_above_threshold": 0,
                "outcome": "fetch_failed",
            })
            continue
        rescored, new_top = rerank_by_thesis[i]
        new_theses.append(Thesis(
            thesis=t.thesis,
            header=t.header,
            supporting_notes=new_top,
            sub_query_types=list(t.sub_query_types),
        ))
        # Outcome metrics: improved / no_help / empty.
        new_top_cosine = rescored[0][0] if rescored else 0.0
        fresh_above_threshold = sum(1 for s, _ in rescored if s >= 0.55)
        fresh_count = len(fresh_by_thesis.get(i, []))
        if not fresh_count:
            outcome = "empty"
        elif new_top_cosine >= 0.55 and new_top_cosine > old_top:
            outcome = "improved"
        else:
            outcome = "no_help"
        per_thesis_summary.append({
            "idx": i, "was_thin": True,
            "old_top_cosine": round(old_top, 3),
            "new_top_cosine": round(new_top_cosine, 3),
            "fresh_fetched": fresh_count,
            "fresh_above_threshold": fresh_above_threshold,
            "outcome": outcome,
        })

    # Strip the internal `_augment_dedup` field before envelopes hit
    # downstream consumers — purely internal-to-this-function bookkeeping.
    for env in additional_envelopes:
        env.pop("_augment_dedup", None)

    enriched = Outline(
        intro=outline.intro,
        theses=new_theses,
        conclusion=outline.conclusion,
        skipped_notes=list(outline.skipped_notes),
        skipped_reason=outline.skipped_reason,
    )

    # Aggregate counters for the outcome distribution — easier to see
    # at a glance in Langfuse than scanning per_thesis array.
    outcome_counts = {"empty": 0, "no_help": 0, "improved": 0, "fetch_failed": 0}
    for entry in per_thesis_summary:
        outcome = entry.get("outcome")
        if outcome in outcome_counts:
            outcome_counts[outcome] += 1
    log.info(
        "augment_summary",
        n_theses=len(outline.theses),
        n_thin=len(thin_indices),
        thin_positions=thin_indices,
        n_fresh_total=len(additional_envelopes),
        outcomes=outcome_counts,
        per_thesis=per_thesis_summary,
    )

    return enriched, additional_envelopes
