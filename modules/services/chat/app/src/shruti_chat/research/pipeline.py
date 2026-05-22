"""run_research — the orchestrator that replaces the LLM-driven ReAct loop
for `router.intent == "research"` turns.

Two paths:
  SHORT (question-attribution match):
    expand_query ∥ find_attributions(kind=question)
    → if matches: fetch_refs + supplementary fanout → return authoritative

  LONG (no match):
    expand_query ∥ find_attributions(kind=question) → no matches
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
from typing import Any, Callable

from shruti_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
)
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.attribution_lookup import find_attributions
from shruti_chat.research.caption_generator import generate_captions
from shruti_chat.research.commentary_expansion import (
    expand_verses_with_commentaries,
)
from shruti_chat.research.constants import (
    DEFAULT_TOPIC_BOOST,
    MAX_FANOUT_ROUNDS,
    TIMEOUT_COMMENTARY_EXPAND_S,
    TIMEOUT_EXPAND_S,
    TIMEOUT_FANOUT_S,
    TIMEOUT_FETCH_REFS_S,
    TIMEOUT_QUESTION_LOOKUP_S,
    TIMEOUT_REGENERATE_S,
    TIMEOUT_TOPIC_EXTRACT_S,
    TIMEOUT_TOPIC_LOOKUP_S,
)
from shruti_chat.research.corpus_fanout import (
    fanout_search_with_boost,
    merge_fanout,
)
from shruti_chat.research.coverage_gate import is_coverage_sufficient
from shruti_chat.research.models import (
    AttributionMatch,
    AttributionRef,
    ExpansionResult,
    FanoutResult,
    ResearchResult,
)
from shruti_chat.research.query_expander import expand_query
from shruti_chat.research.topic_extractor import extract_topics


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
    pull its chunks — gives the user immediate "now consulting BG 2.13"
    feedback instead of waiting on the DB round-trip."""
    if on_event is None:
        return
    target_id = (ref.target_id or "").strip()
    if not target_id:
        return
    if ref.ref_kind == "verse":
        kind = "verse"
        source_id = f"verse:{target_id}"
    else:
        kind = "library_doc"
        source_id = f"library:{target_id}"
    try:
        on_event("research_source", {"kind": kind, "id": source_id, "label": target_id})
    except Exception:  # noqa: BLE001
        log.warning("on_event_research_source_failed", target_id=target_id)


async def _safe(coro_factory, *, default, timeout: float, name: str, request_id: str | None):
    """Run a coroutine with a stage timeout; on TimeoutError / any exception,
    return `default` so the orchestrator can keep going with partial state."""
    try:
        return await asyncio.wait_for(coro_factory(), timeout=timeout)
    except asyncio.TimeoutError:
        log.warning("pipeline_stage_timeout", stage=name, timeout=timeout, request_id=request_id)
        return default
    except Exception as exc:  # noqa: BLE001 — best-effort
        log.warning("pipeline_stage_error", stage=name, error=str(exc), request_id=request_id)
        return default


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
) -> list[str]:
    """Second-pass query expansion that explicitly avoids the previous
    angles. The query_expander prompt + a follow-up hint."""
    found_labels = [e.get("label") or "" for e in found_chunks[:5]]
    follow_up = (
        f"Previous queries attempted: {previous_queries}\n"
        f"Top labels found so far: {found_labels}\n"
        "Generate 3-5 NEW queries that approach the question from angles "
        "NOT covered by the previous queries. Do not repeat what was tried."
    )
    args = {"_followup": follow_up}
    result: ExpansionResult = await expand_query(
        question, lang, args, llm=llm, model=model,
    )
    for q in result.queries:
        _emit_question(on_event, q, question)
    return result.queries


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
    expand_model: str | None = None,
    topic_model: str | None = None,
    confirm_model: str | None = None,
    topic_boost: float = DEFAULT_TOPIC_BOOST,
    request_id: str | None = None,
    on_event: OnEvent | None = None,
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
            question=question, lang=lang, expansion=ExpansionResult(queries=[question]),
            boost_ids=set(),
            chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
            alias_map=alias_map, llm=llm, router_args=router_args,
            topic_boost=topic_boost, expand_model=expand_model,
            request_id=request_id, on_event=on_event,
        )

    # 1. PARALLEL: expand + question-attribution lookup.
    expand_task = asyncio.create_task(_safe(
        lambda: expand_query(question, lang, router_args, llm=llm, model=expand_model),
        default=ExpansionResult(queries=[question]), timeout=TIMEOUT_EXPAND_S,
        name="expand_query", request_id=request_id,
    ))
    q_lookup_task = asyncio.create_task(_safe(
        lambda: find_attributions(
            kind="question", user_q_embedding=user_q_embedding, lang=lang,
            embed_model=embed_model, pool=pool, llm=llm, confirm_model=confirm_model,
        ),
        default=[], timeout=TIMEOUT_QUESTION_LOOKUP_S,
        name="question_lookup", request_id=request_id,
    ))
    expansion: ExpansionResult = await expand_task
    question_matches: list[AttributionMatch] = await q_lookup_task

    # Surface diversified sub-queries the moment they're ready — both
    # SHORT and LONG paths use them. Filtered to skip echoes of the
    # original question (degraded `expand_query` fallback shape).
    for q in expansion.queries:
        _emit_question(on_event, q, question)

    # 2. SHORT PATH — question-attribution found.
    if question_matches:
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
        # canonical theme. No topic-boost in SHORT path.
        supplementary = await _safe(
            lambda: fanout_search_with_boost(
                queries=expansion.queries[:3],
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
            ),
            default=FanoutResult(), timeout=TIMEOUT_FANOUT_S,
            name="supplementary_fanout", request_id=request_id,
        )

        supplementary_top = supplementary.chunks[:8]
        commentaries = await _safe(
            lambda: expand_verses_with_commentaries(
                authoritative + supplementary_top,
                chunk_repo=chunk_repo, alias_map=alias_map,
                lang=lang, on_event=on_event,
            ),
            default=[], timeout=TIMEOUT_COMMENTARY_EXPAND_S,
            name="expand_commentaries_short", request_id=request_id,
        )

        result = ResearchResult(
            authoritative_refs=authoritative,
            research_chunks=supplementary_top + commentaries,
            matched_question_ids=[m.attribution_id for m in question_matches],
            matched_topic_ids=[],
        )
        _kick_caption_gen(
            result, alias_map=alias_map, question=question, lang=lang,
            llm=llm, model=expand_model, request_id=request_id,
        )
        return result

    # 3. LONG PATH.
    long_result = await _research_path(
        question=question, lang=lang, expansion=expansion,
        boost_ids=None,  # computed below from topics
        chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
        alias_map=alias_map, llm=llm, router_args=router_args,
        topic_boost=topic_boost, expand_model=expand_model,
        topic_model=topic_model, embed_model_for_lookup=embed_model, pool=pool,
        request_id=request_id, on_event=on_event,
    )
    _kick_caption_gen(
        long_result, alias_map=alias_map, question=question, lang=lang,
        llm=llm, model=expand_model, request_id=request_id,
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
        ),
    )
    # Hold a strong reference on the alias map so the loop doesn't GC
    # the task before it writes captions.
    alias_map._caption_task = task  # type: ignore[attr-defined]


async def _research_path(
    *,
    question: str,
    lang: str,
    expansion: ExpansionResult,
    boost_ids: set[str] | None,
    chunk_repo: Any,
    catalog_repo: Any,
    embedder: Any,
    alias_map: Any,
    llm: Any,
    router_args: dict[str, Any],
    topic_boost: float,
    expand_model: str | None,
    topic_model: str | None = None,
    embed_model_for_lookup: str | None = None,
    pool: Any | None = None,
    request_id: str | None = None,
    on_event: OnEvent | None = None,
) -> ResearchResult:
    """LONG path: topic-extract → topic-lookup → boost-aware fanout with
    coverage gate and up to MAX_FANOUT_ROUNDS rounds."""
    topic_matches: list[AttributionMatch] = []

    if boost_ids is None and pool is not None and embed_model_for_lookup is not None:
        # Step A: LLM extracts topics from the question.
        topics: list[str] = await _safe(
            lambda: extract_topics(
                question, lang, expansion.queries, llm=llm, model=topic_model,
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
                            embed_model=embed_model_for_lookup, pool=pool,
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

    # Step C: fanout with topic-boost, coverage gate, up to N rounds.
    accumulated = FanoutResult()
    queries = expansion.queries or [question]

    for round_idx in range(MAX_FANOUT_ROUNDS):
        result = await _safe(
            lambda queries=queries: fanout_search_with_boost(
                queries=queries,
                embedder=embedder, chunk_repo=chunk_repo,
                catalog_repo=catalog_repo, alias_map=alias_map, lang=lang,
                boost_ids=boost_ids, boost_factor=topic_boost,
                author_id=router_args.get("author_id"),
                location_id=router_args.get("location_id"),
                tag_ids=router_args.get("tag_ids"),
                date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
                date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
                book_id=router_args.get("source_id"),
                on_event=on_event,
            ),
            default=None, timeout=TIMEOUT_FANOUT_S,
            name=f"fanout_round_{round_idx}", request_id=request_id,
        )
        if result is None:
            break
        accumulated = merge_fanout(accumulated, result)
        accumulated.rounds_executed = round_idx + 1

        if is_coverage_sufficient(accumulated):
            break

        if round_idx + 1 < MAX_FANOUT_ROUNDS:
            queries = await _safe(
                lambda: _regenerate_queries(
                    question, lang, queries, accumulated.chunks,
                    llm=llm, model=expand_model, on_event=on_event,
                ),
                default=[], timeout=TIMEOUT_REGENERATE_S,
                name="regenerate_queries", request_id=request_id,
            )
            if not queries:
                break

    top_chunks = accumulated.chunks[:20]
    commentaries = await _safe(
        lambda: expand_verses_with_commentaries(
            top_chunks,
            chunk_repo=chunk_repo, alias_map=alias_map,
            lang=lang, on_event=on_event,
        ),
        default=[], timeout=TIMEOUT_COMMENTARY_EXPAND_S,
        name="expand_commentaries_long", request_id=request_id,
    )

    return ResearchResult(
        authoritative_refs=[],
        research_chunks=top_chunks + commentaries,
        matched_question_ids=[],
        matched_topic_ids=[m.attribution_id for m in topic_matches],
    )
