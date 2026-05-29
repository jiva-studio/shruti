"""run_research — the orchestrator that replaces the LLM-driven ReAct loop
for `router.intent == "research"` turns.

Two paths:
  SHORT (question-attribution match):
    plan_queries ∥ find_attributions(kind=question)
    → if matches: fetch_refs + supplementary fanout → return authoritative

  LONG (no match):
    plan_queries ∥ find_attributions(kind=question) → no matches
    → extract_topics → embed topics → find_attributions(kind=topic)
    → fanout_search_with_boost (topic-matched item_ids get +0.15)
    → coverage gate; up to MAX_FANOUT_ROUNDS with regenerate_queries between

Every external call is wrapped in `asyncio.wait_for` with a stage-specific
timeout. On timeout: graceful fall-through with partial results, never
block the whole turn.
"""

from __future__ import annotations

import asyncio
from itertools import chain
from time import perf_counter
from typing import Any, Callable

from lectorium_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
)
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.attribution_lookup import find_attributions
from lectorium_chat.research.caption_generator import generate_captions
from lectorium_chat.research.constants import (
    BOOST_BY_KIND,
    MAX_FANOUT_ROUNDS,
    TIMEOUT_FANOUT_S,
    TIMEOUT_FETCH_REFS_S,
    TIMEOUT_PLAN_S,
    TIMEOUT_QUESTION_LOOKUP_S,
    TIMEOUT_REGENERATE_S,
    TIMEOUT_TOPIC_EXTRACT_S,
    TIMEOUT_TOPIC_LOOKUP_S,
)
from lectorium_chat.research.corpus_fanout import (
    fanout_search_with_boost,
    merge_fanout,
)
from lectorium_chat.research.coverage_gate import (
    is_coverage_good_enough,
    should_bail_out,
)
from lectorium_chat.research.models import (
    AttributionMatch,
    AttributionRef,
    FanoutResult,
    QueryPlan,
    ResearchResult,
    SubQuery,
)
from lectorium_chat.research.query_planner import plan_queries
from lectorium_chat.research.topic_extractor import extract_topics


log = get_logger(__name__)


# (event_type, payload) — bridged to the LangGraph stream writer in
# research_worker_node. Pipeline code never knows about SSE.
OnEvent = Callable[[str, dict[str, Any]], None]


def _emit_question(on_event: OnEvent | None, query: str, original: str) -> None:
    """Emit one `research_question` event. Skips echoes of the original
    user question so the panel never shows the user their own words back
    when query expansion degrades to `[question]`.

    Comparison is case-folded so an expansion that re-capitalises the
    question (`"Почему мы страдаем?"` → `"почему мы страдаем"`) still
    counts as an echo — the user-visible payload would be identical
    after the panel's downstream rendering."""
    if on_event is None:
        return
    q = (query or "").strip()
    if not q or q.casefold() == (original or "").strip().casefold():
        return
    try:
        on_event("research_question", {"question": q})
    except Exception:  # noqa: BLE001 — observability must never break research
        log.warning("on_event_research_question_failed", question_chars=len(q))


def _emit_source_for_ref(on_event: OnEvent | None, ref: "AttributionRef") -> None:
    """Emit one `research_source` event for an attribution ref BEFORE we
    pull its chunks — gives the user immediate "now consulting … " feedback
    instead of waiting on the DB round-trip.

    `target_id` is an opaque UUID (`verse_<uuid>` / a library doc id) — it
    must NEVER be the user-visible label (issue #660). We have no addr_label
    in scope yet (that's what the DB fetch is for), so emit a generic
    kind-aware label here. The downstream chunk emission via
    `_emit_research_source` carries the real addr_label once chunks load."""
    if on_event is None:
        return
    target_id = (ref.target_id or "").strip()
    if not target_id:
        return
    if ref.ref_kind == "verse":
        kind = "verse"
        source_id = f"verse:{target_id}"
        label = "verse"
    else:
        kind = "library_doc"
        source_id = f"library:{target_id}"
        label = "library document"
    try:
        on_event("research_source", {"kind": kind, "id": source_id, "label": label})
    except Exception:  # noqa: BLE001
        log.warning("on_event_research_source_failed", target_id=target_id)


async def _safe(coro_factory, *, default, timeout: float, name: str, request_id: str | None):
    """Run a coroutine with a stage timeout; on TimeoutError / any exception,
    return `default` so the orchestrator can keep going with partial state.

    Emits `stage_timing {stage, stage_ms, status}` on every outcome so the
    research pipeline is fully covered by the same instrumentation as the
    rest of the turn — without having to wrap each call site separately.
    """
    started = perf_counter()
    status = "ok"
    try:
        return await asyncio.wait_for(coro_factory(), timeout=timeout)
    except asyncio.TimeoutError:
        status = "timeout"
        log.warning("pipeline_stage_timeout", stage=name, timeout=timeout, request_id=request_id)
        return default
    except Exception as exc:  # noqa: BLE001 — best-effort
        status = "error"
        log.warning("pipeline_stage_error", stage=name, error=str(exc), request_id=request_id)
        return default
    finally:
        log.info(
            "stage_timing",
            stage=name,
            stage_ms=round((perf_counter() - started) * 1000, 1),
            status=status,
            request_id=request_id,
        )


def _plan_to_fanout_queries(plan: QueryPlan) -> list[tuple[int, str]]:
    """Flatten a QueryPlan into the `(sub_query_id, text)` tuples that
    `fanout_search_with_boost` consumes. Each sub_query contributes its
    primary `text` plus every `alt_phrasing` — all tagged with the same
    `sub_query_id` so retrieval can be grouped per sub-question downstream.
    """
    out: list[tuple[int, str]] = []
    for sq in plan.sub_queries:
        out.append((sq.id, sq.text))
        for alt in sq.alt_phrasings:
            out.append((sq.id, alt))
    return out


def _dedupe_refs(refs: list[AttributionRef]) -> list[AttributionRef]:
    seen: set[tuple[str, str]] = set()
    out: list[AttributionRef] = []
    for r in refs:
        key = (r.ref_kind, r.target_id)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


async def _fetch_refs(
    refs: list[AttributionRef],
    *,
    chunk_repo: Any,
    alias_map: Any,
    lang: str | None,
    canonical_score: float,
    on_event: OnEvent | None = None,
) -> list[dict[str, Any]]:
    """Resolve each AttributionRef → chunks → envelopes. Envelopes carry
    `score = canonical_score` (>= 0.85 for accept) so the synthesizer's
    refusal-discipline doesn't drop them as junk.

    For lectures, ref_kind="document" with kind='letter' / 'commentary' /
    'prose_chapter' applies; refs to literal verses use kind='verse'."""
    if not refs:
        return []

    async def _one(ref: AttributionRef) -> list[dict[str, Any]]:
        # Surface the ref the moment we know we're going to consult it —
        # the DB round-trip is what we want to mask, not pad after.
        _emit_source_for_ref(on_event, ref)
        try:
            chunks = await chunk_repo.get_chunks_by_target(
                ref_kind=ref.ref_kind, target_id=ref.target_id, lang=lang,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "fetch_refs_lookup_failed",
                ref_kind=ref.ref_kind, target_id=ref.target_id, error=str(exc),
            )
            return []
        # Native-lang fallback: if no chunks in user's lang, retry without
        # the filter so authoritative refs still surface for cross-lang users.
        if not chunks and lang is not None:
            try:
                chunks = await chunk_repo.get_chunks_by_target(
                    ref_kind=ref.ref_kind, target_id=ref.target_id, lang=None,
                )
            except Exception:  # noqa: BLE001
                chunks = []
        envelopes: list[dict[str, Any]] = []
        for c in chunks:
            env = library_to_envelope(c, alias_map=alias_map, score=canonical_score)
            # Same shape as fanout's _library_dedup_key so merge_fanout-style
            # callers can dedup these alongside fanout output.
            env["_dedup_key"] = (c.item_kind, c.item_id, c.segment_index)
            envelopes.append(env)
        return envelopes

    per_ref = await asyncio.gather(*(_one(r) for r in refs), return_exceptions=False)
    flat: list[dict[str, Any]] = []
    for batch in per_ref:
        flat.extend(batch)
    return flat


async def _regenerate_queries(
    question: str,
    lang: str,
    previous_queries: list[str],
    found_chunks: list[dict[str, Any]],
    *,
    llm: Any,
    model: str | None,
    on_event: OnEvent | None = None,
    callbacks: list[Any] | None = None,
) -> list[tuple[int, str]]:
    """Second-pass query planning that explicitly avoids the previous
    angles. Re-runs the query_planner with a follow-up hint and returns
    `(sub_query_id, text)` tuples ready for `fanout_search_with_boost`.
    """
    found_labels = [e.get("label") or "" for e in found_chunks[:5]]
    follow_up = (
        f"Previous queries attempted: {previous_queries}\n"
        f"Top labels found so far: {found_labels}\n"
        "Produce NEW sub_queries that approach the question from angles "
        "NOT covered by the previous queries. Do not repeat what was tried."
    )
    args = {"_followup": follow_up}
    plan: QueryPlan = await plan_queries(
        question, lang, args, llm=llm, model=model, callbacks=callbacks,
    )
    for sq in plan.sub_queries:
        _emit_question(on_event, sq.text, question)
    return _plan_to_fanout_queries(plan)


async def run_research(
    question: str,
    lang: str,
    router_args: dict[str, Any],
    *,
    chunk_repo: Any,                     # ChunkRepository
    catalog_repo: Any,                   # CatalogRepository
    embedder: Any,                       # EmbedderPort
    alias_map: Any,                      # TurnAliasMap (ctx.aliases)
    pool: Any,                           # asyncpg pool
    llm: Any,                            # LLMPort
    embed_model: str,                    # settings.embed_model
    embed_dim: int,                      # settings.embed_dim — selects attribution_emb_d{N} table
    expand_model: str | None = None,
    topic_model: str | None = None,
    confirm_model: str | None = None,
    boost_by_kind: dict[str, float] | None = None,
    request_id: str | None = None,
    on_event: OnEvent | None = None,
    kv_cache: Any | None = None,
    reranker: Any = None,
    precomputed_query_embedding_task: Any | None = None,
    # Langfuse `CallbackHandler` list, threaded into every LLM call in
    # the pipeline (query expansion, topic extraction, caption
    # generation, attribution confirmation). None = no observability;
    # the LLM adapter then skips the `callbacks` kwarg on each call.
    callbacks: list[Any] | None = None,
) -> ResearchResult:
    """Code-driven research. Called from `research_worker_node` when
    `router.intent == "research"`.

    `on_event` (optional) is a sync `(event_type, payload)` callback the
    pipeline uses to surface sub-queries and inspected sources to the
    client in real-time, BEFORE ranking/dedup. The node bridges it onto
    LangGraph's stream writer. Pure observability — never blocks or
    raises into the research loop."""

    # 0. Embed user question once — reused for question-attribution lookup
    # and (implicitly via topic_embeddings) for the topic stage.
    # Speculative path: `chat_turn` kicks off the embed in parallel with
    # the router, so by the time we get here it's usually done. We
    # `await` the task instead of doing a fresh embed; if the task is
    # absent (older callers, tests) or cancelled, fall back to a sync
    # embed call.
    if precomputed_query_embedding_task is not None:
        async def _await_embed() -> list[float] | None:
            try:
                return await precomputed_query_embedding_task
            except (asyncio.CancelledError, Exception):
                # Speculative task failed — re-embed synchronously.
                return await embedder.embed_query(question)
        user_q_embedding = await _safe(
            _await_embed,
            default=None, timeout=TIMEOUT_QUESTION_LOOKUP_S,
            name="embed_user_query", request_id=request_id,
        )
    else:
        user_q_embedding = await _safe(
            lambda: embedder.embed_query(question),
            default=None, timeout=TIMEOUT_QUESTION_LOOKUP_S,
            name="embed_user_query", request_id=request_id,
        )
    if user_q_embedding is None:
        # No embedding → no attribution lookup possible. Fall straight to
        # plain fanout with the raw question.
        log.warning("pipeline_embed_failed_fanout_only", request_id=request_id)
        return await _research_path(
            question=question, lang=lang,
            plan=QueryPlan(sub_queries=[
                SubQuery(id=0, type="general", text=question, alt_phrasings=[]),
            ]),
            boost_ids=set(),
            chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
            alias_map=alias_map, llm=llm, router_args=router_args,
            boost_by_kind=boost_by_kind, expand_model=expand_model,
            request_id=request_id, on_event=on_event,
            reranker=reranker,
            callbacks=callbacks,
        )

    # 1. PARALLEL: plan + question-attribution lookup + speculative
    # topic extraction. Topic extraction is only consumed by the LONG
    # path (no question_match), but the LLM call is independent of both
    # `plan` and `question_matches` (it uses [] as expansion context in
    # the prompt) so we hide its 0.8-1.4 s latency under `plan_task`
    # instead of paying for it sequentially after we confirm no
    # question_match. On SHORT path the result is discarded.
    plan_task = asyncio.create_task(_safe(
        lambda: plan_queries(
            question, lang, router_args, llm=llm, model=expand_model,
            callbacks=callbacks,
        ),
        default=QueryPlan(sub_queries=[
            SubQuery(id=0, type="general", text=question, alt_phrasings=[]),
        ]),
        timeout=TIMEOUT_PLAN_S,
        name="query_planner", request_id=request_id,
    ))
    q_lookup_task = asyncio.create_task(_safe(
        lambda: find_attributions(
            kind="question", user_q_embedding=user_q_embedding, lang=lang,
            embed_model=embed_model, embed_dim=embed_dim,
            pool=pool, llm=llm, confirm_model=confirm_model,
        ),
        default=[], timeout=TIMEOUT_QUESTION_LOOKUP_S,
        name="question_lookup", request_id=request_id,
    ))
    topic_task: asyncio.Task[list[str]] | None = None
    if pool is not None and embed_model is not None:
        topic_task = asyncio.create_task(_safe(
            lambda: extract_topics(
                question, lang, [],
                llm=llm, model=topic_model, kv_cache=kv_cache,
                callbacks=callbacks,
            ),
            default=[], timeout=TIMEOUT_TOPIC_EXTRACT_S,
            name="extract_topics_speculative", request_id=request_id,
        ))
    plan: QueryPlan = await plan_task
    question_matches: list[AttributionMatch] = await q_lookup_task

    # Surface typed sub-queries the moment they're ready — both SHORT and
    # LONG paths use them. Filtered to skip echoes of the original question
    # (degraded `plan_queries` fallback shape). One event per sub_query;
    # alt_phrasings are NOT surfaced to keep the panel readable.
    for sq in plan.sub_queries:
        _emit_question(on_event, sq.text, question)

    # 2. SHORT PATH — question-attribution found.
    if question_matches:
        # Topic extraction was speculative; SHORT path doesn't use it.
        if topic_task is not None:
            topic_task.cancel()
            topic_task = None
        all_refs = _dedupe_refs(list(chain.from_iterable(m.refs for m in question_matches)))
        top_score = max(m.score for m in question_matches)
        log.info(
            "pipeline_short_path",
            request_id=request_id,
            matches=len(question_matches),
            top_score=round(top_score, 3),
            refs=len(all_refs),
            stage=question_matches[0].stage,
        )

        authoritative = await _safe(
            lambda: _fetch_refs(
                all_refs, chunk_repo=chunk_repo, alias_map=alias_map,
                lang=lang, canonical_score=top_score, on_event=on_event,
            ),
            default=[], timeout=TIMEOUT_FETCH_REFS_S,
            name="fetch_refs", request_id=request_id,
        )

        # Supplementary fanout — broader semantic exploration around the
        # canonical theme. No topic-boost in SHORT path. We cap at the
        # first 3 sub_queries' primary texts only (no alt_phrasings) so
        # SHORT path stays lean — authoritative refs already provide the
        # core grounding.
        supplementary_queries = [
            (sq.id, sq.text) for sq in plan.sub_queries[:3]
        ]
        supplementary = await _safe(
            lambda: fanout_search_with_boost(
                queries=supplementary_queries,
                embedder=embedder, chunk_repo=chunk_repo,
                catalog_repo=catalog_repo, alias_map=alias_map, lang=lang,
                boost_ids=set(),
                author_id=router_args.get("author_id"),
                location_id=router_args.get("location_id"),
                tag_ids=router_args.get("tag_ids"),
                date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
                date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
                book_id=router_args.get("source_id"),
                on_event=on_event,
                reranker=reranker,
                rerank_query=question,
            ),
            default=FanoutResult(), timeout=TIMEOUT_FANOUT_S,
            name="supplementary_fanout", request_id=request_id,
        )

        supplementary_top = supplementary.chunks[:8]
        # Commentary attachment moved POST-planner: `synthesis_planner_node`
        # calls `rerank_and_attach_commentaries` which pulls purports only
        # for verses the planner actually picked into supporting_notes, then
        # cosine-reranks them against each thesis text. Avoids the 12-per-
        # verse flood that previously inflated tool_results to ~92 notes.
        result = ResearchResult(
            authoritative_refs=authoritative,
            research_chunks=supplementary_top,
            matched_question_ids=[m.attribution_id for m in question_matches],
            matched_topic_ids=[],
        )
        _kick_caption_gen(
            result, alias_map=alias_map, question=question, lang=lang,
            llm=llm, model=expand_model, request_id=request_id,
            callbacks=callbacks,
        )
        return result

    # 3. LONG PATH. If the speculative topic task is done by now, hand
    # it through so `_research_path` can skip its own re-extraction.
    speculative_topics: list[str] = []
    if topic_task is not None:
        try:
            speculative_topics = await topic_task
        except (asyncio.CancelledError, Exception):
            speculative_topics = []
    long_result = await _research_path(
        question=question, lang=lang, plan=plan,
        boost_ids=None,  # computed below from topics
        chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
        alias_map=alias_map, llm=llm, router_args=router_args,
        boost_by_kind=boost_by_kind, expand_model=expand_model,
        topic_model=topic_model, embed_model_for_lookup=embed_model,
        embed_dim_for_lookup=embed_dim, pool=pool,
        request_id=request_id, on_event=on_event,
        precomputed_topics=speculative_topics,
        kv_cache=kv_cache,
        reranker=reranker,
        callbacks=callbacks,
    )
    _kick_caption_gen(
        long_result, alias_map=alias_map, question=question, lang=lang,
        llm=llm, model=expand_model, request_id=request_id,
        callbacks=callbacks,
    )
    return long_result


def _kick_caption_gen(
    result: ResearchResult,
    *,
    alias_map: Any,
    question: str,
    lang: str,
    llm: Any,
    model: str | None,
    request_id: str | None,
    callbacks: list[Any] | None = None,
) -> None:
    """Fire-and-forget background Flash-Lite call that fills
    `alias_map.captions` with 2-5 word topic tags for every lecture-
    fragment alias in the result. Reference is stored on the alias map
    so the event loop keeps the task alive (asyncio only holds weak
    refs to tasks). Read by `MarkerExpander` when expanding `[^N]` for
    a `ChunkRef` with timestamps."""
    targets: list[tuple[int, str]] = []
    for env in (*result.authoritative_refs, *result.research_chunks):
        if not isinstance(env, dict):
            continue
        if env.get("type") != "lecture":
            continue
        ref = env.get("ref")
        if not isinstance(ref, int):
            continue
        meta = env.get("meta") or {}
        # Only fragments (with timestamps) need a caption — whole-track
        # cards render as track tiles, no chip-label slot.
        if meta.get("start_ms") is None or meta.get("end_ms") is None:
            continue
        text = (env.get("text") or "").strip()
        if not text:
            continue
        targets.append((ref, text))

    if not targets:
        return

    task = asyncio.create_task(
        generate_captions(
            targets,
            user_question=question, lang=lang,
            llm=llm, model=model,
            captions_out=alias_map.captions,
            request_id=request_id,
            callbacks=callbacks,
        ),
    )
    # Hold a strong reference on the alias map so the loop doesn't GC
    # the task before it writes captions.
    alias_map._caption_task = task  # type: ignore[attr-defined]


async def _research_path(
    *,
    question: str,
    lang: str,
    plan: QueryPlan,
    boost_ids: set[str] | None,
    chunk_repo: Any,
    catalog_repo: Any,
    embedder: Any,
    alias_map: Any,
    llm: Any,
    router_args: dict[str, Any],
    boost_by_kind: dict[str, float] | None,
    expand_model: str | None,
    topic_model: str | None = None,
    embed_model_for_lookup: str | None = None,
    embed_dim_for_lookup: int | None = None,
    pool: Any | None = None,
    request_id: str | None = None,
    on_event: OnEvent | None = None,
    precomputed_topics: list[str] | None = None,
    kv_cache: Any | None = None,
    reranker: Any = None,
    callbacks: list[Any] | None = None,
) -> ResearchResult:
    """LONG path: topic-extract → topic-lookup → boost-aware fanout with
    coverage gate and up to MAX_FANOUT_ROUNDS rounds."""
    topic_matches: list[AttributionMatch] = []

    if (
        boost_ids is None
        and pool is not None
        and embed_model_for_lookup is not None
        and embed_dim_for_lookup is not None
    ):
        # Step A: LLM extracts topics from the question. Use the
        # speculative result from `run_research` if it's available
        # (already paid for under `plan_queries` latency); otherwise
        # extract synchronously here. The topic-extractor receives
        # `plan.sub_queries`'s texts as extra context (same role the
        # old `expansion.queries` list played).
        topics: list[str]
        if precomputed_topics:
            topics = precomputed_topics
        else:
            topics = await _safe(
                lambda: extract_topics(
                    question, lang, [sq.text for sq in plan.sub_queries],
                    llm=llm, model=topic_model, kv_cache=kv_cache,
                    callbacks=callbacks,
                ),
                default=[], timeout=TIMEOUT_TOPIC_EXTRACT_S,
                name="extract_topics", request_id=request_id,
            )

        # Step B: embed all topics in one HTTP call, then parallel pgvector
        # lookups for each.
        boost_ids = set()
        if topics:
            topic_embeddings: list[list[float]] = await _safe(
                lambda: embedder.embed_documents(topics),
                default=[], timeout=TIMEOUT_TOPIC_LOOKUP_S,
                name="embed_topics", request_id=request_id,
            )
            if topic_embeddings:
                lookup_tasks = [
                    _safe(
                        lambda emb=emb: find_attributions(
                            kind="topic", user_q_embedding=emb, lang=lang,
                            embed_model=embed_model_for_lookup,
                            embed_dim=embed_dim_for_lookup,
                            pool=pool,
                        ),
                        default=[], timeout=TIMEOUT_TOPIC_LOOKUP_S,
                        name="topic_lookup", request_id=request_id,
                    )
                    for emb in topic_embeddings
                ]
                topic_match_lists = await asyncio.gather(*lookup_tasks)
                for matches in topic_match_lists:
                    topic_matches.extend(matches)
                boost_ids = {ref.target_id for m in topic_matches for ref in m.refs}

        log.info(
            "pipeline_long_path",
            request_id=request_id,
            topics_extracted=len(topics),
            topic_matches=len(topic_matches),
            boost_ids=len(boost_ids),
        )
    else:
        boost_ids = boost_ids or set()

    # Explicit-fetch attribution-flagged refs so they're GUARANTEED in
    # the candidate pool. Library ANN top-K is narrow (8 per query across
    # all library kinds combined); a short verse-chunk under-scores against
    # long queries and may never enter the pool by cosine alone — boost
    # ranks within the pool, it can't put a chunk INTO the pool. By
    # fetching topic-attribution refs directly (same path SHORT uses for
    # question refs), the curator's "this is relevant" decision survives
    # past the ANN bottleneck. Score 0.75 sits below SHORT's authoritative
    # 0.85 (topic is a weaker signal than question) but above any sensible
    # ANN ranking, so these chunks naturally surface in top-20.
    topic_refs_fetched: list[dict[str, Any]] = []
    if topic_matches:
        topic_refs = _dedupe_refs(
            list(chain.from_iterable(m.refs for m in topic_matches))
        )
        topic_refs_fetched = await _safe(
            lambda: _fetch_refs(
                topic_refs, chunk_repo=chunk_repo, alias_map=alias_map,
                lang=lang, canonical_score=0.75, on_event=on_event,
            ),
            default=[], timeout=TIMEOUT_FETCH_REFS_S,
            name="fetch_topic_refs", request_id=request_id,
        )
        log.info(
            "long_path_topic_refs_fetched",
            request_id=request_id,
            refs=len(topic_refs),
            envelopes=len(topic_refs_fetched),
        )

    # Step C: fanout with topic-boost, coverage gate, up to N rounds.
    accumulated = FanoutResult()
    queries: list[tuple[int, str]] = (
        _plan_to_fanout_queries(plan) or [(0, question)]
    )

    for round_idx in range(MAX_FANOUT_ROUNDS):
        result = await _safe(
            lambda queries=queries: fanout_search_with_boost(
                queries=queries,
                embedder=embedder, chunk_repo=chunk_repo,
                catalog_repo=catalog_repo, alias_map=alias_map, lang=lang,
                boost_ids=boost_ids, boost_by_kind=boost_by_kind,
                author_id=router_args.get("author_id"),
                location_id=router_args.get("location_id"),
                tag_ids=router_args.get("tag_ids"),
                date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
                date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
                book_id=router_args.get("source_id"),
                on_event=on_event,
                reranker=reranker,
                rerank_query=question,
            ),
            default=None, timeout=TIMEOUT_FANOUT_S,
            name=f"fanout_round_{round_idx}", request_id=request_id,
        )
        if result is None:
            break
        accumulated = merge_fanout(accumulated, result)
        accumulated.rounds_executed = round_idx + 1

        if is_coverage_good_enough(accumulated, round_idx):
            break

        # Bail out before paying for regenerate_queries + another
        # fanout round when round 0 had essentially nothing relevant.
        if round_idx == 0 and should_bail_out(accumulated):
            log.info(
                "pipeline_fanout_bailout",
                request_id=request_id,
                max_score=round(accumulated.max_score, 3),
            )
            break

        if round_idx + 1 < MAX_FANOUT_ROUNDS:
            queries = await _safe(
                lambda: _regenerate_queries(
                    question, lang, [q[1] for q in queries], accumulated.chunks,
                    llm=llm, model=expand_model, on_event=on_event,
                    callbacks=callbacks,
                ),
                default=[], timeout=TIMEOUT_REGENERATE_S,
                name="regenerate_queries", request_id=request_id,
            )
            if not queries:
                break

    # Merge topic-fetched refs with fanout candidates, dedup by _dedup_key,
    # take top-20 by score. Topic refs have score=0.75; most fanout chunks
    # land 0.45-0.75, so attribution-flagged items naturally float to the
    # top while still letting strongly-matching lectures surface.
    merged_by_key: dict[tuple, dict[str, Any]] = {}
    for env in topic_refs_fetched + list(accumulated.chunks):
        key = env.get("_dedup_key")
        if key is None:
            continue
        prev = merged_by_key.get(key)
        prev_score = (prev or {}).get("score") or 0.0
        env_score = env.get("score") or 0.0
        if prev is None or prev_score < env_score:
            merged_by_key[key] = env
    # Two-tier order so the cosine and rerank scales are never compared
    # against each other: authoritative attribution refs (fetched outside
    # fanout — cosine ~0.85, no `rerank_score`) pin first by cosine; the
    # reranked fanout chunks follow, ordered by rerank_score (fallback
    # cosine). So a reranked chunk can't displace an authoritative ref and
    # the rerank order survives into the note list. With the reranker off,
    # nothing carries `rerank_score` → this is a stable cosine sort, same
    # as before.
    def _tier_key(e: dict[str, Any]) -> tuple[int, float]:
        rs = e.get("rerank_score")
        if rs is None:
            return (1, e.get("score") or 0.0)   # authoritative ref tier
        return (0, rs)                           # reranked chunk tier
    top_chunks = sorted(
        merged_by_key.values(), key=_tier_key, reverse=True,
    )[:20]

    # Commentary attachment moved POST-planner: see SHORT path comment
    # above. `synthesis_planner_node` now calls
    # `rerank_and_attach_commentaries` per thesis, fetching purports only
    # for verses the planner picked and cosine-reranking them against the
    # thesis text — avoids the upstream flood of ~92 notes.
    return ResearchResult(
        authoritative_refs=[],
        research_chunks=top_chunks,
        matched_question_ids=[],
        matched_topic_ids=[m.attribution_id for m in topic_matches],
    )
