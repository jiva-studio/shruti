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

from shruti_chat.agent.tools._envelope import (
    library_to_envelope,
    resolve_commentary_author_names,
)
from shruti_chat.domain.entities import LibraryChunk
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.constants import (
    MAX_COMMENTARIES_PER_VERSE,
    STAGE1_ATTACH_FLOOR,
    STAGE1_COMMENTARIES_PER_VERSE,
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
    """Single (source_id, tokens) → commentary chunks in `lang` ONLY.

    No cross-language fallback. Callers pass the corpus-clamped
    `retrieval_lang_code` (English for a non-corpus answer). A `lang=None`
    fallback used to fire on a miss and grab the purport in WHATEVER
    language existed — which handed Russian purports to a Serbian / English
    answer. A miss now returns nothing: better no purport than a foreign one.
    """
    try:
        return await chunk_repo.get_chunks_by_verse(
            source_id=source_id, tokens=tokens, kinds=["commentary"], lang=lang,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "expand_commentaries_lookup_failed",
            source_id=source_id, tokens=tokens, error=str(exc),
        )
        return []


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


def _balanced_topk(
    ordered: list[int],
    pool: list[dict[str, Any]],
    *,
    k: int,
    score_of: Callable[[int], float],
    floor: float = THIN_THESIS_MIN_SCORE,
) -> list[int]:
    """Take the top-`k` of a relevance-ordered index list, then — if every
    pick is a `lecture` but a sufficiently-relevant verse/commentary exists
    further down — swap the weakest lecture for it, so a thesis isn't
    lecture-monopolised (prod showed ~4:1). Relevance stays primary: the
    swap only fires when the cut is all-lecture AND the best available
    non-lecture clears `floor`, so a junk shloka can't displace a strong
    spoken source. Mirrors the legacy non-lecture swap, generalised to run
    on any ordered candidate list."""
    if k <= 0 or not ordered:
        return []

    def _typ(one_based: int) -> str | None:
        if not (1 <= one_based <= len(pool)):
            return None
        e = pool[one_based - 1]
        return e.get("type") if isinstance(e, dict) else None

    base = list(ordered[:k])
    if base and all(_typ(i) == "lecture" for i in base):
        picked = set(base)
        best_nl = next(
            (
                i for i in ordered
                if i not in picked
                and _typ(i) in ("verse", "commentary")
                and score_of(i) >= floor
            ),
            None,
        )
        if best_nl is not None:
            base[-1] = best_nl  # swap weakest lecture for the scriptural anchor
    return base


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
    max_commentaries_per_verse: int = STAGE1_COMMENTARIES_PER_VERSE,
    on_event: OnEvent | None = None,
    reranker: Any = None,
    rerank_concurrency: int = 2,
    user_query: str | None = None,
) -> tuple[Any, list[dict[str, Any]]]:
    """Stage 1 of the per-thesis grounding pipeline.

    ENRICHES (never replaces wholesale) each thesis's `supporting_notes`.
    The planner already read the full note text and reasoned about what
    backs each claim, so we trust its selection and only:

      1. Fetch purports for the VERSES the planner attached to a thesis.
      2. Build a per-thesis candidate pool = {the planner's own picks for
         this thesis} ∪ {purports of those picked verses}. This is NOT the
         whole corpus — the reranker can only ORDER within what the
         reasoner chose, it can't pull in an unrelated shloka that merely
         embeds near the thesis sentence (the old whole-pool override was
         the root cause of citations disconnected from the narrative).
      3. Rank that small pool against the claim (`user_query` + thesis):
         cross-encoder when present (query-aware), else cosine.
      4. Keep the planner's own picks unconditionally; gate auto-attached
         purports by a cosine floor; seat a type-balanced top-K (≥1 verse,
         ≥1 purport when available) and stop — no padding to K with noise.

    Returns `(enriched_outline, new_commentary_envelopes)`. The caller
    appends `new_commentary_envelopes` to the LangGraph state's
    `tool_results` (append-reducer) and writes `enriched_outline` back as
    `state["outline"]`.

    Graceful degrade: any exception / missing collaborator returns the
    original outline + [] so the synthesizer keeps the planner's picks.
    """
    # Local import to avoid models <-> commentary_expansion circular dep.
    from shruti_chat.research.models import Outline, Thesis

    if (
        not isinstance(outline, Outline)
        or not outline.theses
        or embedder is None
        or chunk_repo is None
    ):
        return outline, []

    # ── 1. Per-thesis: which verses did the planner pick? ──────────────
    # `thesis_verses[ti]` = the (source_id, tokens) the planner attached to
    # thesis ti. `verse_score` dedups the fetch across theses.
    verse_score: dict[tuple[str, str], float] = {}
    thesis_verses: list[set[tuple[str, str]]] = []
    for t in outline.theses:
        vs: set[tuple[str, str]] = set()
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
            key = (sid, tok)
            vs.add(key)
            score = env.get("score") if isinstance(env.get("score"), (int, float)) else None
            parent = float(score) if score is not None else 0.5
            if verse_score.get(key, -1.0) < parent:
                verse_score[key] = parent
        thesis_verses.append(vs)

    # ── 2. Fetch purports for the picked verses; build envelopes and
    # record each verse's purport indices (1-based, FINAL index space =
    # base_notes + new_envelopes, appended in order). ──────────────────
    new_envelopes: list[dict[str, Any]] = []
    commentary_idx_by_verse: dict[tuple[str, str], list[int]] = {}
    if verse_score:
        pairs = list(verse_score.items())
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

        # Dedup purports already in base_notes (surfaced by standalone ANN).
        # A purport is a WHOLE document: the same item_id surfaced by fanout
        # (under one segment_index) and re-fetched fresh here (under another)
        # is the SAME purport — keying on item_id ALONE (not item_id+segment)
        # is what stops it being cited twice. The fanout envelope's reliable
        # item_id is in its `_dedup_key` ((kind, item_id, segment)); fall back
        # to meta for envelopes built elsewhere.
        seen: set[str] = set()
        for env in base_notes:
            if isinstance(env, dict) and env.get("type") == "commentary":
                dk = env.get("_dedup_key")
                item_id = (
                    dk[1] if isinstance(dk, tuple) and len(dk) >= 2
                    else (env.get("meta") or {}).get("item_id")
                )
                if item_id is not None:
                    seen.add(str(item_id))

        pending: list[LibraryChunk] = []
        pending_key: list[tuple[str, str]] = []
        pending_score: list[float] = []
        for (key, parent_score), chunks in zip(pairs, chunk_lists):
            if not chunks:
                continue
            capped = _select_capped(chunks, cap=max_commentaries_per_verse)
            child_score = max(0.0, parent_score - 0.05)
            for c in capped:
                dedup_key = str(c.item_id)
                if dedup_key in seen:
                    continue
                seen.add(dedup_key)
                pending.append(c)
                pending_key.append(key)
                pending_score.append(child_score)

        if pending:
            try:
                author_names = await resolve_commentary_author_names(
                    pending, catalog_repo=catalog_repo, lang=lang,
                )
            except Exception:  # noqa: BLE001
                author_names = {}
            for c, key, child_score in zip(pending, pending_key, pending_score):
                author_name = author_names.get(c.author_id) if c.author_id else None
                extra = {"author_name": author_name} if author_name else None
                env = library_to_envelope(
                    c, alias_map=alias_map, score=child_score, extra_meta=extra,
                )
                new_envelopes.append(env)
                # Just appended → its FINAL 1-based pool index.
                final_idx = len(base_notes) + len(new_envelopes)
                commentary_idx_by_verse.setdefault(key, []).append(final_idx)
                _emit_commentary_source(on_event, c)

    # FINAL index space the synthesizer will see after the append-reducer.
    pool_envelopes = list(base_notes) + new_envelopes

    # ── 3. Per-thesis candidate pools = planner picks ∪ their purports ──
    per_thesis_candidates: list[list[int]] = []
    per_thesis_planner: list[set[int]] = []
    all_candidate_idx: set[int] = set()
    for ti, t in enumerate(outline.theses):
        seen_c: set[int] = set()
        cand: list[int] = []
        planner_set: set[int] = set()
        for note_idx in t.supporting_notes:
            if 1 <= note_idx <= len(pool_envelopes) and note_idx not in seen_c:
                cand.append(note_idx)
                seen_c.add(note_idx)
                planner_set.add(note_idx)
        for key in thesis_verses[ti]:
            for ci in commentary_idx_by_verse.get(key, []):
                if ci not in seen_c:
                    cand.append(ci)
                    seen_c.add(ci)
        per_thesis_candidates.append(cand)
        per_thesis_planner.append(planner_set)
        all_candidate_idx.update(cand)

    # Claim text per thesis (Task C): query-aware (user question) + claim-
    # aware (header + thesis). Empty user_query degrades to thesis only.
    def _claim(t: Any) -> str:
        parts = [p for p in (t.header, t.thesis) if p]
        claim = " — ".join(parts) if parts else (t.thesis or "")
        return f"{user_query}\n{claim}" if user_query else claim

    thesis_claims = [_claim(t) for t in outline.theses]

    # Batch the cosine gate: embed every claim + every candidate text once.
    # The pool is small (picks + a few purports), not the whole corpus.
    cand_list = sorted(all_candidate_idx)
    cand_text = {i: (pool_envelopes[i - 1].get("text") or "").strip() for i in cand_list}
    embed_idx = [i for i in cand_list if cand_text[i]]

    cos_by_thesis_idx: dict[tuple[int, int], float] = {}
    if embed_idx:
        try:
            # Claims are QUERIES, candidate purports are DOCUMENTS — embed each
            # through its own prefix path (a no-op on a symmetric model, but
            # the only correct call on an asymmetric one). Fired concurrently.
            claim_embeds, cand_embed_list = await asyncio.gather(
                embedder.embed_queries(thesis_claims),
                embedder.embed_documents([cand_text[i] for i in embed_idx]),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("rerank_embed_failed", error=str(exc))
            claim_embeds, cand_embed_list = [], []
        if (
            len(claim_embeds) == len(thesis_claims)
            and len(cand_embed_list) == len(embed_idx)
        ):
            cand_embeds = {
                embed_idx[k]: cand_embed_list[k]
                for k in range(len(embed_idx))
            }
            for ti, c_emb in enumerate(claim_embeds):
                for i in per_thesis_candidates[ti]:
                    emb = cand_embeds.get(i)
                    if emb is not None:
                        cos_by_thesis_idx[(ti, i)] = _cosine(c_emb, emb)

    # ── 4. Per-thesis selection. Keep the planner's own picks; gate
    # auto-attached purports by the floor; order by reranker (claim+query)
    # else cosine; type-balance into the top-K. The reranker ORDERS the
    # candidate set, it never changes its membership. ──────────────────
    sem = asyncio.Semaphore(max(1, rerank_concurrency))

    def _cos_order(ti: int, kept: list[int]) -> list[int]:
        return sorted(
            kept, key=lambda i: cos_by_thesis_idx.get((ti, i), 0.0), reverse=True,
        )

    async def _order(ti: int, kept: list[int]) -> list[int]:
        if len(kept) <= 1 or reranker is None:
            return _cos_order(ti, kept)
        pairs = [(i, cand_text.get(i, "")) for i in kept if cand_text.get(i, "")]
        if len(pairs) < 2:
            return _cos_order(ti, kept)
        async with sem:
            try:
                scored = await reranker.rerank(
                    thesis_claims[ti], [txt for _, txt in pairs], top_k=len(pairs),
                )
            except Exception as exc:  # noqa: BLE001 — never fail a turn
                log.warning("stage1_rerank_failed", error=str(exc))
                scored = None
        if not scored:
            return _cos_order(ti, kept)
        ordered = [pairs[j][0] for j, _ in scored if 0 <= j < len(pairs)]
        # Keep membership stable: append anything the reranker dropped.
        for i in kept:
            if i not in ordered:
                ordered.append(i)
        return ordered

    order_results = await asyncio.gather(
        *(_order(ti, per_thesis_candidates[ti]) for ti in range(len(outline.theses)))
    )

    new_theses: list[Thesis] = []
    per_thesis_obs: list[dict] = []
    for ti, (t, ordered) in enumerate(zip(outline.theses, order_results)):
        planner_set = per_thesis_planner[ti]
        # Planner picks are never gated (the reasoner vetted them); only the
        # purports we attached on top must clear the floor.
        kept = [
            i for i in ordered
            if i in planner_set
            or cos_by_thesis_idx.get((ti, i), 0.0) >= STAGE1_ATTACH_FLOOR
        ]
        if not kept:
            kept = list(ordered) or list(t.supporting_notes)
        new_supporting = _balanced_topk(
            kept, pool_envelopes, k=top_k_per_thesis,
            score_of=lambda i, _ti=ti: cos_by_thesis_idx.get((_ti, i), 0.0),
        )
        if not new_supporting:
            # Outline.supporting_notes is min_length=1 — never emit empty.
            new_supporting = list(t.supporting_notes)
        new_theses.append(Thesis(
            thesis=t.thesis,
            header=t.header,
            supporting_notes=new_supporting,
            sub_query_types=list(t.sub_query_types),
        ))
        type_counts: dict[str, int] = {}
        for i in new_supporting:
            e = pool_envelopes[i - 1] if 1 <= i <= len(pool_envelopes) else {}
            kind = (e.get("type") if isinstance(e, dict) else None) or "?"
            type_counts[kind] = type_counts.get(kind, 0) + 1
        per_thesis_obs.append({
            "n_candidates": len(per_thesis_candidates[ti]),
            "n_planner_picks": len(planner_set),
            "n_supporting": len(new_supporting),
            "top_cosine": round(
                max((cos_by_thesis_idx.get((ti, i), 0.0) for i in new_supporting),
                    default=0.0), 3),
            "type_mix": type_counts,
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
        n_verses_expanded=len(verse_score),
        per_thesis=per_thesis_obs,
    )

    return enriched, new_envelopes
