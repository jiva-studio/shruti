"""commentary_expansion — when a verse appears in the research result,
pull every commentary anchored on that verse (all authors) and append
them as supplementary context for the synthesizer.

Verses found by ANN don't carry their authored commentaries with them
automatically — the LLM ends up answering about БГ 2.13 without
Prabhupada's purport or Vishvanatha's tika as grounding. This helper
closes that gap by doing one extra round of address-keyed lookups
after the main fanout.

Operates on already-built envelopes (post-`library_to_envelope`) so it
sits cleanly between fanout and `ResearchResult` construction, doesn't
touch domain entities, and is trivially unit-testable.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from lectorium_chat.agent.tools._envelope import (
    library_to_envelope,
    resolve_commentary_author_names,
)
from lectorium_chat.domain.entities import LibraryChunk
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.constants import (
    MAX_COMMENTARIES_PER_VERSE,
    THIN_THESIS_MIN_SCORE,
)


log = get_logger(__name__)

OnEvent = Callable[[str, dict[str, Any]], None]


def _emit_commentary_source(on_event: OnEvent | None, chunk: LibraryChunk) -> None:
    """Surface a pulled commentary in the mobile progress panel alongside the
    fanout sources. Drops (no event) when there's no real `addr_label` — the
    panel is purely visual, so an empty chip is worse than nothing."""
    if on_event is None:
        return
    label = (chunk.addr_label or "").strip()
    if not label:
        return
    try:
        on_event(
            "research_source",
            {
                "kind": "commentary",
                "id": f"library:{chunk.item_id}",
                "label": label,
            },
        )
    except Exception:  # noqa: BLE001 — observability must never break research
        log.warning("on_event_commentary_source_failed", item_id=chunk.item_id)


async def _fetch_one(
    chunk_repo: Any,
    *,
    source_id: str,
    tokens: str,
    lang: str | None,
) -> list[LibraryChunk]:
    """Single (source_id, tokens) → commentary chunks, with native-lang
    fallback identical to `_fetch_refs` in pipeline.py."""
    try:
        chunks = await chunk_repo.get_chunks_by_verse(
            source_id=source_id, tokens=tokens, kinds=["commentary"], lang=lang,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "expand_commentaries_lookup_failed",
            source_id=source_id, tokens=tokens, error=str(exc),
        )
        return []
    if not chunks and lang is not None:
        try:
            chunks = await chunk_repo.get_chunks_by_verse(
                source_id=source_id, tokens=tokens, kinds=["commentary"], lang=None,
            )
        except Exception:  # noqa: BLE001
            chunks = []
    return chunks


def _select_capped(
    chunks: list[LibraryChunk],
    *,
    cap: int,
) -> list[LibraryChunk]:
    """Pick at most `cap` chunks, prioritising one segment per distinct
    author_id first (round-robin order preserved), then filling the rest
    with the remaining segments. Keeps wide author coverage on a verse
    that has many purports."""
    if cap <= 0 or not chunks:
        return []
    first_pass: list[LibraryChunk] = []
    leftover: list[LibraryChunk] = []
    seen_authors: set[str | None] = set()
    for c in chunks:
        if c.author_id in seen_authors:
            leftover.append(c)
        else:
            seen_authors.add(c.author_id)
            first_pass.append(c)
    selected = first_pass[:cap]
    if len(selected) < cap:
        selected.extend(leftover[: cap - len(selected)])
    return selected


async def expand_verses_with_commentaries(
    envelopes: list[dict[str, Any]],
    *,
    chunk_repo: Any,
    alias_map: Any,
    lang: str | None,
    catalog_repo: Any | None = None,
    max_commentaries_per_verse: int = MAX_COMMENTARIES_PER_VERSE,
    on_event: OnEvent | None = None,
) -> list[dict[str, Any]]:
    """For each verse envelope in `envelopes`, pull all commentaries on
    that verse (all authors) and return them as new commentary envelopes.

    Caller is responsible for appending the result to its chunk list.
    Input `envelopes` is read-only — never mutated.

    Dedup: commentaries already present in `envelopes` (e.g. surfaced by
    ANN on their own) are skipped. Commentary chunks appearing under
    multiple input verses are emitted once.

    Score: parent verse's score minus 0.05 — keeps the commentary just
    below its anchor in the ranked list while staying above the 0.45
    relevance floor for any real verse hit. Verses without a numeric
    score fall back to 0.5.
    """
    verse_pairs: dict[tuple[str, str], float] = {}
    seen_commentary: set[tuple[str, int]] = set()

    for env in envelopes:
        if not isinstance(env, dict):
            continue
        env_type = env.get("type")
        meta = env.get("meta") or {}
        if env_type == "verse":
            source_id = meta.get("source_id")
            tokens = meta.get("tokens")
            if not source_id or not tokens:
                continue
            score = env.get("score") if isinstance(env.get("score"), (int, float)) else None
            parent_score = float(score) if score is not None else 0.5
            key = (source_id, tokens)
            prev = verse_pairs.get(key)
            if prev is None or prev < parent_score:
                verse_pairs[key] = parent_score
        elif env_type == "commentary":
            item_id = meta.get("item_id") or env.get("ref")
            seg = meta.get("segment_index", 0)
            if item_id is not None:
                seen_commentary.add((str(item_id), int(seg or 0)))

    if not verse_pairs:
        return []

    pairs = list(verse_pairs.items())
    chunk_lists = await asyncio.gather(
        *(
            _fetch_one(chunk_repo, source_id=sid, tokens=tok, lang=lang)
            for (sid, tok), _score in pairs
        )
    )

    out: list[dict[str, Any]] = []
    pending: list[LibraryChunk] = []
    pending_score: list[float] = []
    for ((_sid, _tok), parent_score), chunks in zip(pairs, chunk_lists):
        if not chunks:
            log.info("expand_commentaries_empty", source_id=_sid, tokens=_tok)
            continue
        capped = _select_capped(chunks, cap=max_commentaries_per_verse)
        child_score = max(0.0, parent_score - 0.05)
        for c in capped:
            dedup_key = (c.item_id, c.segment_index or 0)
            if dedup_key in seen_commentary:
                continue
            seen_commentary.add(dedup_key)
            pending.append(c)
            pending_score.append(child_score)

    # Batch-resolve human author names so the synthesizer can render
    # "БГ 2.13 — комментарий А.Ч. Бхактиведанты Свами Прабхупады"
    # instead of three identically-headed "БГ 2.13" blocks the LLM
    # can't tell apart. Same helper is used by `chunks_search` so a
    # standalone commentary hit gets the same enrichment.
    author_names = await resolve_commentary_author_names(
        pending, catalog_repo=catalog_repo, lang=lang,
    )

    for c, child_score in zip(pending, pending_score):
        # Pre-resolve author_name so alias_commentary captures it for
        # the marker expander's attribution line.
        author_name = (
            author_names.get(c.author_id) if c.author_id else None
        )
        extra = {"author_name": author_name} if author_name else None
        env = library_to_envelope(
            c, alias_map=alias_map, score=child_score, extra_meta=extra,
        )
        out.append(env)
        _emit_commentary_source(on_event, c)
    return out


def _cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity for unit-norm or near-unit-norm embeddings
    (OpenAI / Voyage / BGE-M3 all return normalised vectors). When the
    norms are tiny (zero-length text → embedder returned zeros) the
    score collapses to 0 — safer than dividing by ~0.
    """
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


async def rerank_and_attach_commentaries(
    outline: Any,                       # Outline (avoid circular import)
    base_notes: list[dict[str, Any]],
    *,
    chunk_repo: Any,
    embedder: Any,
    alias_map: Any,
    lang: str | None,
    catalog_repo: Any | None = None,
    top_k_per_thesis: int = 5,
    max_commentaries_per_verse: int = MAX_COMMENTARIES_PER_VERSE,
    on_event: OnEvent | None = None,
    reranker: Any = None,
    rerank_concurrency: int = 2,
) -> tuple[Any, list[dict[str, Any]]]:
    """Stage 1 of the per-thesis rerank pipeline.

    For each thesis in `outline.theses`:
      1. For each verse referenced in the planner's tentative
         `supporting_notes`, fetch its commentaries (address-based DB
         lookup). Skipped when no verse is referenced.
      2. Build a pool = base_notes + fetched_commentaries.
      3. Batched-embed thesis_text + every pool note text in ONE call.
      4. Rank by cosine(thesis, note). Keep top-K (default 5).
      5. Rewrite thesis.supporting_notes to point to those top-K via
         their indices into the FINAL tool_results that the synthesizer
         will see (= base_notes + the new_commentaries returned here).

    Returns `(enriched_outline, new_commentary_envelopes)`. The caller
    appends `new_commentary_envelopes` to the LangGraph state's
    `tool_results` (which uses an append-reducer), and writes
    `enriched_outline` back as `state["outline"]`.

    Graceful degrade: any exception during embedding or DB lookup
    returns the original outline + [] so the synthesizer keeps the
    planner's tentative attributions.
    """
    # Local import to avoid models <-> commentary_expansion circular dep.
    from lectorium_chat.research.models import Outline, Thesis

    if (
        not isinstance(outline, Outline)
        or not outline.theses
        or embedder is None
        or chunk_repo is None
    ):
        return outline, []

    # ── 1. Collect verses referenced across all theses, dedup ──────────
    # Address-keyed lookup means same (source_id, tokens) fetched once
    # even if multiple theses reference it.
    verse_pairs: dict[tuple[str, str], float] = {}
    for t in outline.theses:
        for note_idx in t.supporting_notes:
            if not (1 <= note_idx <= len(base_notes)):
                continue
            env = base_notes[note_idx - 1]
            if not isinstance(env, dict) or env.get("type") != "verse":
                continue
            meta = env.get("meta") or {}
            sid = meta.get("source_id")
            tok = meta.get("tokens")
            if not sid or not tok:
                continue
            score = env.get("score") if isinstance(env.get("score"), (int, float)) else None
            parent = float(score) if score is not None else 0.5
            key = (sid, tok)
            prev = verse_pairs.get(key)
            if prev is None or prev < parent:
                verse_pairs[key] = parent

    # ── 2. Fetch commentaries for each referenced verse ────────────────
    new_envelopes: list[dict[str, Any]] = []
    if verse_pairs:
        pairs = list(verse_pairs.items())
        try:
            chunk_lists = await asyncio.gather(
                *(
                    _fetch_one(chunk_repo, source_id=sid, tokens=tok, lang=lang)
                    for (sid, tok), _ in pairs
                )
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("rerank_attach_fetch_failed", error=str(exc))
            chunk_lists = [[] for _ in pairs]

        # Dedup commentaries already in base_notes (might have been
        # surfaced by standalone ANN on commentary kind).
        seen: set[tuple[str, int]] = set()
        for env in base_notes:
            if isinstance(env, dict) and env.get("type") == "commentary":
                meta = env.get("meta") or {}
                item_id = meta.get("item_id") or env.get("ref")
                if item_id is not None:
                    seen.add((str(item_id), int(meta.get("segment_index", 0) or 0)))

        pending: list[LibraryChunk] = []
        pending_score: list[float] = []
        for ((_sid, _tok), parent_score), chunks in zip(pairs, chunk_lists):
            if not chunks:
                continue
            capped = _select_capped(chunks, cap=max_commentaries_per_verse)
            child_score = max(0.0, parent_score - 0.05)
            for c in capped:
                dedup_key = (c.item_id, c.segment_index or 0)
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)
                pending.append(c)
                pending_score.append(child_score)

        if pending:
            try:
                author_names = await resolve_commentary_author_names(
                    pending, catalog_repo=catalog_repo, lang=lang,
                )
            except Exception:  # noqa: BLE001
                author_names = {}
            for c, child_score in zip(pending, pending_score):
                author_name = author_names.get(c.author_id) if c.author_id else None
                extra = {"author_name": author_name} if author_name else None
                env = library_to_envelope(
                    c, alias_map=alias_map, score=child_score, extra_meta=extra,
                )
                new_envelopes.append(env)
                _emit_commentary_source(on_event, c)

    # ── 3. Build the pool with FINAL indices (1-based, matching what
    # the synthesizer's _format_tool_results will assign post-append). ──
    pool_envelopes = list(base_notes) + new_envelopes
    pool_texts = [(env.get("text") or "").strip() for env in pool_envelopes]

    # Drop empty-text envelopes from rerank consideration — their
    # embedding would be ~zero and the score meaningless. They stay in
    # tool_results (synthesizer might still show their addr_label), just
    # can't be picked as supporting_notes by the reranker.
    rerank_indices = [i for i, t in enumerate(pool_texts) if t]
    if not rerank_indices:
        return outline, new_envelopes

    # ── 4. Batched embed: theses + all pool note texts in ONE call ─────
    thesis_texts = [t.thesis for t in outline.theses]
    try:
        all_embeds = await embedder.embed_documents(
            thesis_texts + [pool_texts[i] for i in rerank_indices]
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("rerank_embed_failed", error=str(exc))
        return outline, new_envelopes

    if len(all_embeds) != len(thesis_texts) + len(rerank_indices):
        log.warning(
            "rerank_embed_count_mismatch",
            expected=len(thesis_texts) + len(rerank_indices),
            got=len(all_embeds),
        )
        return outline, new_envelopes

    thesis_embeds = all_embeds[: len(thesis_texts)]
    note_embeds_by_idx: dict[int, list[float]] = {
        rerank_indices[k]: all_embeds[len(thesis_texts) + k]
        for k in range(len(rerank_indices))
    }

    # ── 5a. Cross-encoder: per-thesis rerank over the SAME pool, anchored
    # on the thesis statement alone. Owns the grounding selection; cosine
    # stays as the fallback (+ feeds Stage 2 thin-detection). Runs per
    # thesis in parallel, bounded by rerank_concurrency. Any failure ⇒
    # fall back to cosine for that thesis. ─────────────────────────────
    rerank_pool_idx = list(note_embeds_by_idx.keys())  # pool indices, rerankable
    rerank_by_thesis: dict[int, list[int]] = {}
    if reranker is not None and rerank_pool_idx:
        rerank_texts = [pool_texts[i] for i in rerank_pool_idx]
        sem = asyncio.Semaphore(max(1, rerank_concurrency))

        async def _rerank_one(claim: str) -> list[int] | None:
            if not claim.strip():
                return None
            async with sem:
                try:
                    scored = await reranker.rerank(
                        claim, rerank_texts, top_k=top_k_per_thesis,
                    )
                except Exception as exc:  # noqa: BLE001 — never fail a turn
                    log.warning("stage1_rerank_failed", error=str(exc))
                    return None
            # Voyage `index` points into rerank_texts → map to pool index.
            return [rerank_pool_idx[i] for i, _ in scored[:top_k_per_thesis]
                    if 0 <= i < len(rerank_pool_idx)]

        results = await asyncio.gather(
            *(_rerank_one(t.thesis) for t in outline.theses)
        )
        for ti, picks in enumerate(results):
            if picks:
                rerank_by_thesis[ti] = picks

    # ── 5b. Per-thesis: cosine over pool → top-K (fallback / observability);
    # reranker picks override the supporting_notes when present. ────────
    new_theses: list[Thesis] = []
    # Per-thesis observability: top cosine + supporting-note type mix.
    # Skipped-note diagnostics: how strong was the BEST note we DIDN'T
    # pick? When a thesis's top-K caps short, the skipped-max tells us
    # if there's real material being dropped (high) vs noise (low).
    per_thesis_obs: list[dict] = []

    for ti, (t, t_emb) in enumerate(zip(outline.theses, thesis_embeds)):
        scored: list[tuple[float, int]] = []
        for pool_idx, n_emb in note_embeds_by_idx.items():
            score = _cosine(t_emb, n_emb)
            scored.append((score, pool_idx))
        scored.sort(reverse=True)
        top = scored[:top_k_per_thesis]
        # Cross-encoder picks own the grounding selection when present;
        # else fall back to the cosine top-K. Convert pool index (0-based)
        # to 1-based supporting_notes index matching the synthesizer's
        # enumerate(start=1) numbering.
        rerank_picks = rerank_by_thesis.get(ti)
        if rerank_picks:
            new_supporting = [pool_idx + 1 for pool_idx in rerank_picks]
        else:
            new_supporting = [pool_idx + 1 for _, pool_idx in top]
        if not new_supporting:
            # Nothing picked — keep planner's original picks so the
            # synthesizer still has SOMETHING to cite.
            new_supporting = list(t.supporting_notes)

        # Non-lecture slot: if every pick is a lecture but a strong (≥
        # THIN_THESIS_MIN_SCORE) verse/commentary exists in the pool, swap the
        # weakest (last) lecture for it. Keeps theses from being lecture-
        # monopolised (prod showed ~4:1) without changing the slot count or
        # 1-based indexing. Swap, never append.
        def _ptype(one_based: int) -> str | None:
            env = pool_envelopes[one_based - 1]
            return env.get("type") if isinstance(env, dict) else None

        if new_supporting and all(_ptype(i) == "lecture" for i in new_supporting):
            picked = set(new_supporting)
            best_nl = next(
                (
                    pool_idx for s, pool_idx in scored
                    if s >= THIN_THESIS_MIN_SCORE
                    and (pool_idx + 1) not in picked
                    and isinstance(pool_envelopes[pool_idx], dict)
                    and pool_envelopes[pool_idx].get("type") in ("verse", "commentary")
                ),
                None,
            )
            if best_nl is not None:
                new_supporting[-1] = best_nl + 1

        new_theses.append(Thesis(
            thesis=t.thesis,
            header=t.header,
            supporting_notes=new_supporting,
            sub_query_types=list(t.sub_query_types),
        ))
        # Type mix of the FINAL picks (post non-lecture swap) — tells us if a
        # thesis ended up commentary-heavy / verse-heavy / lecture-heavy.
        type_counts: dict[str, int] = {}
        for one_based in new_supporting:
            kind = _ptype(one_based) or "?"
            type_counts[kind] = type_counts.get(kind, 0) + 1
        skipped_after_cap = scored[top_k_per_thesis:]
        per_thesis_obs.append({
            "n_supporting": len(new_supporting),
            "top_cosine": round(top[0][0], 3) if top else 0.0,
            "median_cosine": round(
                top[len(top) // 2][0], 3) if top else 0.0,
            "type_mix": type_counts,
            "n_above_threshold": sum(1 for s, _ in top if s >= 0.55),
            # The strongest note we did NOT keep — flags potential
            # under-coverage when this is also above threshold.
            "skipped_max_cosine": round(
                skipped_after_cap[0][0], 3) if skipped_after_cap else 0.0,
        })

    enriched = Outline(
        intro=outline.intro,
        theses=new_theses,
        conclusion=outline.conclusion,
        skipped_notes=list(outline.skipped_notes),
        skipped_reason=outline.skipped_reason,
    )

    log.info(
        "rerank_attach_done",
        n_theses=len(outline.theses),
        n_base_notes=len(base_notes),
        n_new_commentaries=len(new_envelopes),
        n_verses_expanded=len(verse_pairs),
        per_thesis=per_thesis_obs,
    )

    return enriched, new_envelopes
