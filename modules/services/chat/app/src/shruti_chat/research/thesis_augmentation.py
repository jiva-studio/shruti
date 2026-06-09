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


async def _fresh_fanout_for_thesis(
    thesis_embedding: list[float],
    *,
    chunk_repo: Any,
    catalog_repo: Any,
    router_args: dict[str, Any],
    lang: str | None,
    top_k: int,
) -> tuple[list[Any], list[Any]]:
    """Single thesis-targeted ANN fetch. Mirrors `fanout_search_with_boost`'s
    inner per-query call but skips the boost / dedup / multi-query
    machinery — we're augmenting one thesis with one focused query.

    Respects the user's router_args filters (author / location / date / tag)
    so augmentation can't smuggle in chunks outside their intent.
    """
    eligible = await catalog_repo.filter_track_ids(
        author_id=router_args.get("author_id"),
        source_id=router_args.get("source_id"),
        location_id=router_args.get("location_id"),
        tag_ids=router_args.get("tag_ids"),
        date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
        date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
    )
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
            source_id=router_args.get("source_id"),
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

    # ── 1. Embed all theses in one batched call ─────────────────────────
    thesis_texts = [t.thesis for t in outline.theses]
    try:
        thesis_embeds = await embedder.embed_documents(thesis_texts)
    except Exception as exc:  # noqa: BLE001
        log.warning("augment_thesis_embed_failed", error=str(exc))
        return outline, []
    if len(thesis_embeds) != len(thesis_texts):
        log.warning(
            "augment_thesis_embed_count_mismatch",
            expected=len(thesis_texts),
            got=len(thesis_embeds),
        )
        return outline, []

    # ── 2. For each thesis, cosine-score its CURRENT supporting_notes ───
    # Need note embeddings to score. Batch-embed only the note texts we
    # actually need (those that appear in any supporting_notes). Saves
    # the embed cost on notes that no thesis cares about.
    referenced_indices: set[int] = set()
    for t in outline.theses:
        for idx in t.supporting_notes:
            if 1 <= idx <= len(base_notes):
                referenced_indices.add(idx)

    ref_idx_list = sorted(referenced_indices)
    ref_texts = [(base_notes[i - 1].get("text") or "").strip() for i in ref_idx_list]
    nonempty_refs = [(idx, txt) for idx, txt in zip(ref_idx_list, ref_texts) if txt]

    note_embed_by_idx: dict[int, list[float]] = {}
    if nonempty_refs:
        try:
            ref_embeds = await embedder.embed_documents([t for _, t in nonempty_refs])
        except Exception as exc:  # noqa: BLE001
            log.warning("augment_ref_note_embed_failed", error=str(exc))
            return outline, []
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

    # Track per-thesis the new supporting_notes (computed below); we
    # collect into a list[Thesis] and build the final Outline at the end.
    new_theses: list[Thesis] = []
    next_pool_idx = len(base_notes) + 1  # 1-based; new chunks get this index

    # Per-thesis observability for the summary log emitted below.
    # Captures the augmentation outcome so traces show whether augment
    # actually helped or just paid latency for nothing.
    per_thesis_summary: list[dict] = []

    for i, t in enumerate(outline.theses):
        old_top = (
            per_thesis_scored[i][0][0] if per_thesis_scored[i] else 0.0
        )

        if i not in thin_indices:
            # Strong thesis — passthrough Stage 1's supporting_notes.
            new_theses.append(t)
            per_thesis_summary.append({
                "idx": i,
                "was_thin": False,
                "old_top_cosine": round(old_top, 3),
                "new_top_cosine": round(old_top, 3),
                "fresh_fetched": 0,
                "fresh_above_threshold": 0,
            })
            continue

        try:
            lec_scored, lib_scored = await _fresh_fanout_for_thesis(
                thesis_embeds[i],
                chunk_repo=chunk_repo,
                catalog_repo=catalog_repo,
                router_args=router_args,
                lang=lang,
                top_k=fresh_top_k,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "augment_fresh_fetch_failed",
                thesis_idx=i, error=str(exc),
            )
            new_theses.append(t)
            per_thesis_summary.append({
                "idx": i,
                "was_thin": True,
                "old_top_cosine": round(old_top, 3),
                "new_top_cosine": round(old_top, 3),
                "fresh_fetched": 0,
                "fresh_above_threshold": 0,
                "outcome": "fetch_failed",
            })
            continue

        # Convert raw ScoredChunk → envelopes; dedup against already-added.
        fresh_for_this_thesis: list[tuple[int, dict[str, Any]]] = []
        for s in lec_scored:
            chunk = s.chunk
            key = ("lecture", chunk.track_id, chunk.start_ms, chunk.end_ms)
            if key in dedup_seen:
                # Already fetched by previous thin thesis — reuse its index.
                # Find the existing index in additional_envelopes.
                existing_idx = next(
                    (n + len(base_notes) + 1 for n, env in enumerate(additional_envelopes)
                     if env.get("_augment_dedup") == key),
                    None,
                )
                if existing_idx is not None:
                    fresh_for_this_thesis.append((existing_idx, additional_envelopes[existing_idx - len(base_notes) - 1]))
                continue
            dedup_seen.add(key)
            env = lecture_to_envelope(chunk, alias_map=alias_map, score=s.score)
            env["_augment_dedup"] = key  # for cross-thesis dedup
            additional_envelopes.append(env)
            this_idx = next_pool_idx
            next_pool_idx += 1
            fresh_for_this_thesis.append((this_idx, env))
        # Batch-resolve human author names for the fresh library chunks so
        # an augmentation-fetched commentary / prose / letter carries its
        # attribution — same enrichment chunks_search + commentary_expansion
        # do. Without it the synthesizer blockquote renders address-only.
        lib_author_names = await resolve_commentary_author_names(
            [s.chunk for s in lib_scored], catalog_repo=catalog_repo, lang=lang,
        )
        for s in lib_scored:
            chunk = s.chunk
            key = (chunk.item_kind, chunk.item_id, chunk.segment_index or 0)
            if key in dedup_seen:
                existing_idx = next(
                    (n + len(base_notes) + 1 for n, env in enumerate(additional_envelopes)
                     if env.get("_augment_dedup") == key),
                    None,
                )
                if existing_idx is not None:
                    fresh_for_this_thesis.append((existing_idx, additional_envelopes[existing_idx - len(base_notes) - 1]))
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
            this_idx = next_pool_idx
            next_pool_idx += 1
            fresh_for_this_thesis.append((this_idx, env))

        # Re-rank: pool = current supporting_notes (already scored) +
        # fresh chunks (need scoring).
        rescored: list[tuple[float, int]] = list(per_thesis_scored[i])
        if fresh_for_this_thesis:
            fresh_texts = [(env.get("text") or "").strip() for _, env in fresh_for_this_thesis]
            keep_pairs = [
                (idx, txt) for (idx, _), txt in zip(fresh_for_this_thesis, fresh_texts) if txt
            ]
            if keep_pairs:
                try:
                    fresh_embeds = await embedder.embed_documents([txt for _, txt in keep_pairs])
                except Exception as exc:  # noqa: BLE001
                    log.warning(
                        "augment_fresh_embed_failed",
                        thesis_idx=i, error=str(exc),
                    )
                    fresh_embeds = []
                if len(fresh_embeds) == len(keep_pairs):
                    for (idx, _), f_emb in zip(keep_pairs, fresh_embeds):
                        rescored.append((_cosine(thesis_embeds[i], f_emb), idx))

        rescored.sort(reverse=True)
        cosine_order = [idx for _, idx in rescored]

        # Cross-encoder ORDERS the same pool (current supporting_notes +
        # fresh chunks) against the CLAIM (user query + thesis) — query-
        # aware, not the bare thesis sentence. `_is_thin` detection above
        # stays on cosine. Any failure ⇒ keep the cosine order. The
        # reranker only re-orders the pool; the type-balanced cut below
        # makes the final selection.
        ordered = cosine_order
        if reranker is not None:
            pool_idx = list(cosine_order)
            pool_texts: list[str] = []
            for idx in pool_idx:
                if 1 <= idx <= len(base_notes):
                    txt = (base_notes[idx - 1].get("text") or "").strip()
                else:
                    env = next(
                        (e for j, e in fresh_for_this_thesis if j == idx), None
                    )
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
                    # Keep membership stable — append anything the reranker
                    # dropped (empty-text notes weren't sent to it).
                    for idx in pool_idx:
                        if idx not in rr_order:
                            rr_order.append(idx)
                    ordered = rr_order

        # Type-balanced cut: top-K, de-monopolised away from all-lecture
        # when a relevant verse/purport exists. `additional_envelopes`
        # already holds every fresh chunk (this thesis's included), so
        # base_notes + additional_envelopes covers all pool indices.
        pool_for_pick = list(base_notes) + list(additional_envelopes)
        cos_map = {idx: s for s, idx in rescored}
        new_top = _balanced_topk(
            ordered, pool_for_pick, k=top_k_per_thesis,
            score_of=lambda i: cos_map.get(i, 0.0),
        )

        # Defensive: never let augment empty out a thesis. If something
        # weird happened (no fresh, no original), keep the original picks.
        if not new_top:
            new_top = list(t.supporting_notes)

        new_theses.append(Thesis(
            thesis=t.thesis,
            header=t.header,
            supporting_notes=new_top,
            sub_query_types=list(t.sub_query_types),
        ))

        # Augment outcome metrics. Distinguish three cases:
        #   - "improved": new_top_cosine ≥ threshold AND > old_top
        #   - "no_help":   fresh fetched but couldn't beat existing
        #   - "empty":     fresh fetch returned nothing
        new_top_cosine = rescored[0][0] if rescored else 0.0
        fresh_above_threshold = sum(
            1 for s, _ in rescored if s >= 0.55
        )
        if not fresh_for_this_thesis:
            outcome = "empty"
        elif new_top_cosine >= 0.55 and new_top_cosine > old_top:
            outcome = "improved"
        else:
            outcome = "no_help"
        per_thesis_summary.append({
            "idx": i,
            "was_thin": True,
            "old_top_cosine": round(old_top, 3),
            "new_top_cosine": round(new_top_cosine, 3),
            "fresh_fetched": len(fresh_for_this_thesis),
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
