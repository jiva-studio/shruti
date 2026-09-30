"""run_research — the code-driven orchestrator for
`router.intent == "research"` turns.

A sufficiency gate (`research.sufficiency.assess_sufficiency`) buckets the turn
from curated evidence already in hand — a pinned question-attribution OR a strong
memory match → CORRECT, else INCORRECT — and `policy_for` maps the bucket to a
`RetrievalPolicy` preset that drives one of two paths (LEAN/WIDE, also called
SHORT/LONG):

  LEAN (`_lean_path`, policy.wide_fanout=False):
    curated authoritative refs (pinned question refs and/or a matched memory's
    shlokas) + a bounded supplementary fanout over the first
    `policy.supplementary_subqueries` sub-queries → slate capped at
    `policy.slate_size`.

  WIDE (`_research_path`, policy.wide_fanout=True):
    extract_topics → embed topics → find_attributions(kind=boost) →
    fanout_search_with_boost with a coverage gate, up to
    `policy.max_fanout_rounds` rounds with regenerate_queries between.

A matched memory is awaited BEFORE the fork so it can take the LEAN path instead
of paying the full WIDE sweep; its note + curator refs are folded onto the result
by `attach_memory` regardless of path.

Every external call is wrapped in `asyncio.wait_for` with a stage-specific
timeout. On timeout: graceful fall-through with partial results, never
block the whole turn.
"""

from __future__ import annotations

import asyncio
from itertools import chain
from typing import Any, Callable

from shruti_chat.domain.ports.memo_cache import MemoCache
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.attribution_lookup import find_attributions
from shruti_chat.research.caption_generator import generate_captions
from shruti_chat.research.constants import (
    DEFAULT_FANOUT_DB_CONCURRENCY,
    FINAL_CUT_MIN_LIBRARY,
    FINAL_CUT_MIN_VERSES,
    MEMORY_REF_SCORE,
    MEMORY_SUBQUERY_CAP,
    REGEN_MAX_SUBQUERIES,
    RERANK_RESERVE_FLOOR,
    TIMEOUT_FANOUT_S,
    TIMEOUT_FETCH_REFS_S,
    TIMEOUT_PLAN_S,
    TIMEOUT_MEMORY_LOOKUP_S,
    TIMEOUT_QUESTION_LOOKUP_S,
    TIMEOUT_REGENERATE_S,
    TIMEOUT_TOPIC_EXTRACT_S,
    TIMEOUT_TOPIC_LOOKUP_S,
    WIDE_POLICY,
    RetrievalPolicy,
)
from shruti_chat.research.corpus_fanout import (
    OnEvent,
    fanout_search_with_boost,
    merge_fanout,
)
from shruti_chat.research.kind_intent import boost_kinds_from
from shruti_chat.research.coverage_gate import (
    is_coverage_good_enough,
    should_bail_out,
)
from shruti_chat.research.memory import attach_memory, resolve_memory
from shruti_chat.research.models import (
    AttributionMatch,
    FanoutResult,
    MemoryResolution,
    QueryPlan,
    ResearchResult,
    SubQuery,
)
from shruti_chat.research.query_planner import plan_queries
from shruti_chat.research.refs import dedupe_refs, fetch_refs, gate_topic_refs
from shruti_chat.research.stage import run_stage
from shruti_chat.research.sufficiency import assess_sufficiency, policy_for
from shruti_chat.research.task_scope import cancel_and_wait
from shruti_chat.research.topic_extractor import extract_topics


log = get_logger(__name__)


def _emit_question(on_event: OnEvent | None, query: str, original: str) -> None:
    """Emit one `research_question` event. Skips echoes of the original
    user question so the panel never shows the user their own words back
    when query expansion degrades to `[question]`.

    Comparison is case-folded so an expansion that re-capitalises the
    question (`"Why do we suffer?"` → `"why do we suffer"`) still
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


async def _await_precomputed_embedding(task, embedder, question: str) -> list[float] | None:
    """Await the speculative query embed `chat_turn` kicked off in parallel with
    the router; if it failed, re-embed synchronously.

    `CancelledError` is deliberately NOT caught. This runs inside `run_stage`, so
    the cancellation delivered here is usually the stage timeout's own — and
    swallowing it starts a *fresh* embed that outlives the budget, after which
    `wait_for` sees a plain value, calls `uncancel()` and reports success. The
    same swallow absorbs an explicit Stop and the turn budget.
    """
    try:
        return await task
    except Exception:  # noqa: BLE001 — speculative task failed; re-embed.
        return await embedder.embed_query(question)


_LIBRARY_DOC_TYPES = ("commentary", "prose_chapter", "letter")


def _balanced_cut(
    envs: list[dict[str, Any]],
    n: int,
    *,
    min_verses: int = FINAL_CUT_MIN_VERSES,
    min_library: int = FINAL_CUT_MIN_LIBRARY,
) -> list[dict[str, Any]]:
    """Take the top-`n` envelopes by their existing order, then back-fill verse
    and library-doc types from the tail so a hard cap doesn't drop the kinds the
    rerank reserve fought to seat. Back-fill is gated by RERANK_RESERVE_FLOOR on
    the cosine `score`, so we never promote low-relevance junk past the cut.

    Envelope order is assumed already meaningful (rerank/tier sort). Mirrors the
    membership-not-ordering rationale of the `_rerank_pool` reserve: the planner
    reads the whole set, so a slightly-larger-than-`n` set is fine."""
    if len(envs) <= n:
        return list(envs)
    top = list(envs[:n])
    tail = envs[n:]

    def _back_fill(pred: Callable[[str | None], bool], minimum: int) -> None:
        have = sum(1 for e in top if pred(e.get("type")))
        for e in tail:
            if have >= minimum:
                break
            # The list is ordered by rerank_score, so gate the back-fill on it
            # too: a reranked item carries a `rerank_score` and has ALREADY been
            # cross-encoder-vetted — gating it on the cosine `score` floor would
            # reject a terse verse the reranker rescued (low cosine, high
            # rerank). Items WITHOUT a rerank_score (reranker off / authoritative
            # refs) still gate on the cosine floor.
            if not pred(e.get("type")):
                continue
            if e.get("rerank_score") is not None:
                top.append(e)
                have += 1
            elif (e.get("score") or 0.0) >= RERANK_RESERVE_FLOOR:
                top.append(e)
                have += 1

    _back_fill(lambda t: t == "verse", min_verses)
    _back_fill(lambda t: t in _LIBRARY_DOC_TYPES, min_library)
    return top


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
    # Bound the second round: take the first N regenerated sub_queries by
    # PRIMARY text only (no alt_phrasings). Round 0 already fanned out the
    # full breadth; the regenerate pass just needs a handful of fresh angles,
    # and replaying every alt_phrasing is what makes round-1 the tail-latency
    # spike. See REGEN_MAX_SUBQUERIES.
    capped = plan.sub_queries[:REGEN_MAX_SUBQUERIES]
    for sq in capped:
        _emit_question(on_event, sq.text, question)
    return [(sq.id, sq.text) for sq in capped]


async def run_research(
    question: str,
    lang: str,
    router_args: dict[str, Any],
    *,
    retrieval_lang_code: str | None = None,   # corpus-constrained retrieval lang
    chunk_repo: Any,                     # ChunkRepository
    catalog_repo: Any,                   # CatalogRepository
    embedder: Any,                       # EmbedderPort
    alias_map: Any,                      # TurnAliasMap (ctx.aliases)
    llm: Any,                            # LLMPort
    library_repo: Any | None = None,     # LibraryRepository — full document bodies for pinned doc refs
    expand_model: str | None = None,
    topic_model: str | None = None,
    confirm_model: str | None = None,
    request_id: str | None = None,
    on_event: OnEvent | None = None,
    memo_cache: MemoCache | None = None,
    reranker: Any = None,
    precomputed_query_embedding_task: Any | None = None,
    # Langfuse `CallbackHandler` list, threaded into every LLM call in
    # the pipeline (query expansion, topic extraction, caption
    # generation, attribution confirmation). None = no observability;
    # the LLM adapter then skips the `callbacks` kwarg on each call.
    callbacks: list[Any] | None = None,
    # ACL for the private per-user lecture lane: the set of
    # `user_track` ids this user owns, resolved server-side from the `owned`
    # projection keyed on the JWT `sub`. None / empty ⇒ the private lane is
    # off and retrieval is the public corpus only.
    owned_track_ids: list[str] | None = None,
    # The turn's author selection (`application.author_scope.AuthorScope`).
    # Narrows every LECTURE retrieval below; books are canon and untouched.
    author_scope: Any | None = None,
    fanout_db_concurrency: int = DEFAULT_FANOUT_DB_CONCURRENCY,
) -> ResearchResult:
    """Code-driven research. Called from `research_worker_node` when
    `router.intent == "research"`.

    `on_event` (optional) is a sync `(event_type, payload)` callback the
    pipeline uses to surface sub-queries and inspected sources to the
    client in real-time, BEFORE ranking/dedup. The node bridges it onto
    LangGraph's stream writer. Pure observability — never blocks or
    raises into the research loop.

    `retrieval_lang_code` is the corpus-constrained language EVERY retrieval lane
    (fanout, ref-fetch, attribution lookup, address fast-path) runs in. It
    is always a real corpus language (the worker derives it via
    `clamp_retrieval_lang`); `lang` (the answer language) drives the planner
    / topic-extraction / caption prose only. It defaults to `lang` when
    unset."""

    if retrieval_lang_code is None:
        retrieval_lang_code = lang

    # 0. Embed user question once — reused for question-attribution lookup
    # and (implicitly via topic_embeddings) for the topic stage.
    # Speculative path: `chat_turn` kicks off the embed in parallel with
    # the router, so by the time we get here it's usually done. We
    # `await` the task instead of doing a fresh embed; if the task is
    # absent (e.g. in tests) or failed, fall back to a sync embed
    # call.
    if precomputed_query_embedding_task is not None:
        user_q_embedding = await run_stage(
            lambda: _await_precomputed_embedding(
                precomputed_query_embedding_task, embedder, question,
            ),
            default=None, timeout=TIMEOUT_QUESTION_LOOKUP_S,
            name="embed_user_query", request_id=request_id,
        )
    else:
        user_q_embedding = await run_stage(
            lambda: embedder.embed_query(question),
            default=None, timeout=TIMEOUT_QUESTION_LOOKUP_S,
            name="embed_user_query", request_id=request_id,
        )
    if user_q_embedding is None:
        # No embedding → no attribution lookup possible. Fall straight to
        # plain fanout with the raw question.
        log.warning("pipeline_embed_failed_fanout_only", request_id=request_id)
        return await _research_path(
            question=question, lang=lang, retrieval_lang_code=retrieval_lang_code,
            plan=QueryPlan(sub_queries=[
                SubQuery(id=0, type="general", text=question, alt_phrasings=[]),
            ]),
            chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
            alias_map=alias_map, llm=llm, router_args=router_args,
            expand_model=expand_model,
            library_repo=library_repo,
            request_id=request_id, on_event=on_event,
            reranker=reranker,
            callbacks=callbacks,
            owned_track_ids=owned_track_ids,
            author_scope=author_scope,
            fanout_db_concurrency=fanout_db_concurrency,
        )

    # 1. PARALLEL: plan + question-attribution lookup + speculative
    # topic extraction. Topic extraction is only consumed by the LONG
    # path (no question_match), but the LLM call is independent of both
    # `plan` and `question_matches` (it uses [] as expansion context in
    # the prompt) so we hide its 0.8-1.4 s latency under `plan_task`
    # instead of paying for it sequentially after we confirm no
    # question_match. On SHORT path the result is discarded.
    plan_task: asyncio.Task[QueryPlan] | None = None
    q_lookup_task: asyncio.Task[list[AttributionMatch]] | None = None
    topic_task: asyncio.Task[list[str]] | None = None
    memory_task: asyncio.Task[MemoryResolution] | None = None
    try:
        plan_task = asyncio.create_task(run_stage(
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
        q_lookup_task = asyncio.create_task(run_stage(
            lambda: find_attributions(
                kind="pinned", user_q_embedding=user_q_embedding, lang=retrieval_lang_code,
                chunk_repo=chunk_repo, reranker=reranker, user_query=question,
                llm=llm, confirm_model=confirm_model,
            ),
            default=[], timeout=TIMEOUT_QUESTION_LOOKUP_S,
            name="question_lookup", request_id=request_id,
        ))
        if chunk_repo is not None:
            topic_task = asyncio.create_task(run_stage(
                lambda: extract_topics(
                    question, lang, [],
                    llm=llm, model=topic_model, memo_cache=memo_cache,
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

        # Memory lookup runs concurrently with retrieval and applies to BOTH paths.
        # Reuses the planner's rephrasings (sub-query texts + their alt_phrasings) so
        # a memory matches on ANY angle of the question, not just the raw wording —
        # no trigger-per-phrasing needed. Deduped + capped to bound the lookups.
        _seen_mem_q: set[str] = set()
        sub_query_texts: list[str] = []
        for sq in plan.sub_queries:
            for txt in (sq.text, *sq.alt_phrasings):
                t = (txt or "").strip()
                if t and t != question and t.lower() not in _seen_mem_q:
                    _seen_mem_q.add(t.lower())
                    sub_query_texts.append(t)
        sub_query_texts = sub_query_texts[:MEMORY_SUBQUERY_CAP]
        memory_task = asyncio.create_task(run_stage(
            lambda: resolve_memory(
                user_q_embedding=user_q_embedding, sub_query_texts=sub_query_texts,
                embedder=embedder, retrieval_lang_code=retrieval_lang_code,
                answer_lang=lang, chunk_repo=chunk_repo, alias_map=alias_map,
                library_repo=library_repo, catalog_repo=catalog_repo, on_event=on_event,
                author_scope=author_scope,
                user_query=question, reranker=reranker, llm=llm, confirm_model=confirm_model,
            ),
            default=MemoryResolution(),
            timeout=TIMEOUT_MEMORY_LOOKUP_S,
            name="memory_lookup", request_id=request_id,
        ))

        # 2. SUFFICIENCY GATE. Await the curated memory match and decide BEFORE the
        # wide fanout whether curated authoritative evidence already answers the
        # turn. A pinned question-attribution or a strong memory match is a CORRECT
        # trigger, so a memory-answered turn takes the lean path instead of paying
        # the full WIDE corpus sweep (100-200 sources).
        #
        # Cost: memory_task is created only after the plan resolves (it consumes
        # the plan's sub-queries), so awaiting it here puts the lookup on the
        # pre-fork critical path. The gate needs the result to choose the path;
        # the cost is small because the lookup overlaps the still-running
        # speculative topic_task.
        memory_result = await memory_task
        bucket = assess_sufficiency(question_matches, memory_result)
        policy = policy_for(bucket)

        if not policy.wide_fanout:
            # Topic extraction was speculative; the lean path doesn't use it.
            if topic_task is not None:
                topic_task.cancel()
            result = await _lean_path(
                policy=policy,
                question_matches=question_matches,
                memory_envelopes=memory_result.envelopes,
                plan=plan, question=question, lang=lang, retrieval_lang_code=retrieval_lang_code,
                chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
                alias_map=alias_map, llm=llm, router_args=router_args,
                expand_model=expand_model, library_repo=library_repo,
                request_id=request_id, on_event=on_event, reranker=reranker,
                owned_track_ids=owned_track_ids,
                author_scope=author_scope,
                fanout_db_concurrency=fanout_db_concurrency,
            )
            attach_memory(result, memory_result)
            _kick_caption_gen(
                result, alias_map=alias_map, question=question, lang=lang,
                llm=llm, model=expand_model, request_id=request_id,
                callbacks=callbacks,
            )
            return result

        # 3. LONG PATH (INCORRECT — no curated authoritative evidence). If the
        # speculative topic task is done by now, hand it through so `_research_path`
        # can skip its own re-extraction.
        speculative_topics: list[str] = []
        if topic_task is not None:
            try:
                speculative_topics = await topic_task
            except Exception:  # noqa: BLE001 — speculative; a cancel must propagate.
                speculative_topics = []
        long_result = await _research_path(
            policy=policy,
            question=question, lang=lang, retrieval_lang_code=retrieval_lang_code, plan=plan,
            chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
            alias_map=alias_map, llm=llm, router_args=router_args,
            expand_model=expand_model,
            topic_model=topic_model,
            library_repo=library_repo,
            request_id=request_id, on_event=on_event,
            precomputed_topics=speculative_topics,
            memo_cache=memo_cache,
            reranker=reranker,
            callbacks=callbacks,
            owned_track_ids=owned_track_ids,
            author_scope=author_scope,
            fanout_db_concurrency=fanout_db_concurrency,
        )
        attach_memory(long_result, memory_result)
        _kick_caption_gen(
            long_result, alias_map=alias_map, question=question, lang=lang,
            llm=llm, model=expand_model, request_id=request_id,
            callbacks=callbacks,
        )
        return long_result
    finally:
        # A cancelled turn, or a provider-unavailable error re-raised by any
        # stage, must not leave the other lookups running past this call.
        await cancel_and_wait(plan_task, q_lookup_task, topic_task, memory_task)


async def _lean_path(
    *,
    policy: RetrievalPolicy,
    question_matches: list[AttributionMatch],
    memory_envelopes: list[dict[str, Any]] | None = None,
    plan: QueryPlan,
    question: str,
    lang: str,
    retrieval_lang_code: str,
    chunk_repo: Any,
    catalog_repo: Any,
    embedder: Any,
    alias_map: Any,
    llm: Any,
    router_args: dict[str, Any],
    expand_model: str | None,
    library_repo: Any | None,
    request_id: str | None,
    on_event: OnEvent | None,
    reranker: Any,
    owned_track_ids: list[str] | None = None,
    author_scope: Any | None = None,
    fanout_db_concurrency: int = DEFAULT_FANOUT_DB_CONCURRENCY,
) -> ResearchResult:
    """Lean retrieval taken whenever the sufficiency gate returns CORRECT —
    a pinned question-attribution OR a strong memory match.

    Curated authoritative refs are PINNED ahead of a bounded supplementary
    fanout. On a pinned match the question-attribution refs are fetched here; on
    a memory-only CORRECT there are no pinned refs (the memory's own shlokas are
    folded in by `attach_memory` in the caller). `memory_envelopes` (the
    already-resolved memory refs) are passed in so the supplementary dedup can
    suppress fragments of memory-pinned documents even though the attach happens
    later. Either way the supplementary fanout explores the canonical theme
    around the curated core without the full WIDE corpus sweep."""
    # Pinned question-attribution refs (empty on a memory-only CORRECT).
    all_refs = dedupe_refs(
        list(chain.from_iterable(m.refs for m in question_matches))
    )
    top_score = max((m.score for m in question_matches), default=MEMORY_REF_SCORE)
    log.info(
        "pipeline_lean_path",
        request_id=request_id,
        policy=policy.name,
        pinned_matches=len(question_matches),
        top_score=round(top_score, 3),
        pinned_refs=len(all_refs),
        stage=question_matches[0].stage if question_matches else "memory",
    )

    # Supplementary fanout — broader semantic exploration around the canonical
    # theme. No topic-boost. Capped at the first 3 sub_queries' primary texts
    # only (no alt_phrasings) so the lean path stays lean — authoritative refs
    # already provide the core grounding. fetch_refs and the fanout are
    # independent reads, run concurrently so the lean path costs max(fetch,
    # fanout) not their sum.
    supplementary_queries = [
        (sq.id, sq.text) for sq in plan.sub_queries[: policy.supplementary_subqueries]
    ]
    fetch_task = asyncio.create_task(run_stage(
        lambda: fetch_refs(
            all_refs, chunk_repo=chunk_repo, alias_map=alias_map,
            lang=retrieval_lang_code, canonical_score=top_score, on_event=on_event,
            library_repo=library_repo, catalog_repo=catalog_repo,
            author_scope=author_scope,
        ),
        default=[], timeout=TIMEOUT_FETCH_REFS_S,
        name="fetch_refs", request_id=request_id,
    ))
    fanout_task = asyncio.create_task(run_stage(
        lambda: fanout_search_with_boost(
            queries=supplementary_queries,
            embedder=embedder, chunk_repo=chunk_repo,
            catalog_repo=catalog_repo, alias_map=alias_map, lang=retrieval_lang_code,
            author_id=router_args.get("author_id"),
            location_id=router_args.get("location_id"),
            tag_ids=router_args.get("tag_ids"),
            date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
            date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
            book_id=router_args.get("source_id"),
            on_event=on_event,
            reranker=reranker,
            rerank_query=question,
            db_concurrency=fanout_db_concurrency,
            boost_kinds=boost_kinds_from(
                question, router_args,
                author_asked=bool(
                    author_scope is not None
                    and author_scope.selection.constrained
                ),
            ),
            owned_track_ids=owned_track_ids,
            author_scope=author_scope,
        ),
        default=FanoutResult(), timeout=TIMEOUT_FANOUT_S,
        name="supplementary_fanout", request_id=request_id,
    ))
    try:
        authoritative, supplementary = await asyncio.gather(fetch_task, fanout_task)
    finally:
        await cancel_and_wait(fetch_task, fanout_task)

    # Drop supplementary fanout chunks that belong to a document already pulled
    # IN FULL via the authoritative refs. The ref fetch pulls every chunk of the
    # document by item_id, so any fanout hit from the same item_id is a redundant
    # fragment of a source we already have whole. `_dedup_key = (kind, item_id,
    # segment)`; element [1] is the library item_id (or a track_id for lectures,
    # which never collides with an item_id namespace).
    #
    # `memory_envelopes` are folded in too: on a memory-only CORRECT turn there
    # are NO pinned refs (question_matches == []), so the memory's curator-picked
    # docs are the only authoritative material — and they're appended to the
    # result by `attach_memory` AFTER this function returns. Without them here, a
    # memory-pinned full document would be cited piecemeal alongside its fanout
    # fragments (the worker's exact-key dedup misses it: full-body segment 0 vs a
    # fragment's segment N). Including their item_ids closes that hole.
    authoritative_item_ids = {
        env["_dedup_key"][1]
        for env in (*authoritative, *(memory_envelopes or []))
        if env.get("_dedup_key")
    }
    deduped_supplementary = [
        ch for ch in supplementary.chunks
        if not (ch.get("_dedup_key") and ch["_dedup_key"][1] in authoritative_item_ids)
    ]
    dropped = len(supplementary.chunks) - len(deduped_supplementary)
    if dropped:
        log.info(
            "lean_path_supplementary_deduped",
            request_id=request_id, dropped=dropped, kept=len(deduped_supplementary),
        )
    supplementary_top = _balanced_cut(deduped_supplementary, policy.slate_size)
    # Commentary attachment happens after the planner: `synthesis_planner_node`
    # calls `rerank_and_attach_commentaries` for verses the planner actually picked.
    return ResearchResult(
        authoritative_refs=authoritative,
        research_chunks=supplementary_top,
        matched_question_ids=[m.attribution_id for m in question_matches],
        matched_topic_ids=[],
    )


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
    """Background Flash-Lite call that fills `alias_map.captions` with 2-5
    word topic tags for every lecture-fragment alias in the result. The
    task is registered on the alias map, which holds it for the rest of
    the turn and cancels it when the turn ends; each call adds its own
    task. Read by `MarkerExpander` when expanding `[^N]` for a `ChunkRef`
    with timestamps."""
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
        # The fragment transcript for `flush_cite_payloads` is stashed at
        # mint time in `lecture_to_envelope` (alias_map.chunk_texts[ref] =
        # chunk.text), the single choke point for every cite-able lecture ref.
        # This loop only builds caption targets.

    if not targets:
        return

    alias_map.track_background(asyncio.create_task(
        generate_captions(
            targets,
            user_question=question, lang=lang,
            llm=llm, model=model,
            captions_out=alias_map.captions,
            request_id=request_id,
            callbacks=callbacks,
        ),
        name="caption_gen",
    ))


async def _research_path(
    *,
    policy: RetrievalPolicy = WIDE_POLICY,
    question: str,
    lang: str,
    retrieval_lang_code: str | None = None,
    plan: QueryPlan,
    chunk_repo: Any,
    catalog_repo: Any,
    embedder: Any,
    alias_map: Any,
    llm: Any,
    router_args: dict[str, Any],
    expand_model: str | None,
    topic_model: str | None = None,
    library_repo: Any | None = None,
    request_id: str | None = None,
    on_event: OnEvent | None = None,
    precomputed_topics: list[str] | None = None,
    memo_cache: MemoCache | None = None,
    reranker: Any = None,
    callbacks: list[Any] | None = None,
    owned_track_ids: list[str] | None = None,
    author_scope: Any | None = None,
    fanout_db_concurrency: int = DEFAULT_FANOUT_DB_CONCURRENCY,
) -> ResearchResult:
    """WIDE path: topic-extract → topic-lookup → fanout with coverage gate
    and up to `policy.max_fanout_rounds` rounds (default WIDE_POLICY).

    `retrieval_lang_code` (corpus-constrained) drives every retrieval call;
    `lang` (answer language) drives the topic-extraction prose only.
    `retrieval_lang_code` defaults to `lang`."""
    if retrieval_lang_code is None:
        retrieval_lang_code = lang
    # Topic-attribution refs (extract → embed → lookup → fetch → gate) are
    # INDEPENDENT of the fanout: the fanout's only inputs are the plan queries +
    # boost_kinds(question, router_args) — never topic_matches — and the two
    # outputs are merged below by keyed dedup (order-independent). So the topic
    # refs are produced in a task that runs CONCURRENTLY with the fanout loop,
    # hiding the topic embed+lookup+fetch+gate latency (~1s) under it. Both
    # touch alias_map / on_event, which is asyncio-safe (alias minting is
    # synchronous between awaits); only the research_source event order
    # interleaves, which the client dedups by id.
    async def _produce_topic_refs() -> tuple[list[AttributionMatch], list[dict[str, Any]]]:
        topic_matches: list[AttributionMatch] = []
        if chunk_repo is not None:
            # Step A: LLM extracts topics from the question. Use the
            # speculative result from `run_research` if it's available
            # (already paid for under `plan_queries` latency); otherwise
            # extract synchronously here.
            topics: list[str]
            if precomputed_topics:
                topics = precomputed_topics
            else:
                topics = await run_stage(
                    lambda: extract_topics(
                        question, lang, [sq.text for sq in plan.sub_queries],
                        llm=llm, model=topic_model, memo_cache=memo_cache,
                        callbacks=callbacks,
                    ),
                    default=[], timeout=TIMEOUT_TOPIC_EXTRACT_S,
                    name="extract_topics", request_id=request_id,
                )

            # Step B: embed all topics in one HTTP call, then parallel pgvector
            # lookups for each.
            if topics:
                topic_embeddings: list[list[float]] = await run_stage(
                    lambda: embedder.embed_queries(topics),
                    default=[], timeout=TIMEOUT_TOPIC_LOOKUP_S,
                    name="embed_topics", request_id=request_id,
                )
                if topic_embeddings:
                    lookup_tasks = [
                        asyncio.create_task(run_stage(
                            lambda emb=emb: find_attributions(
                                kind="boost", user_q_embedding=emb,
                                lang=retrieval_lang_code, chunk_repo=chunk_repo,
                            ),
                            default=[], timeout=TIMEOUT_TOPIC_LOOKUP_S,
                            name="topic_lookup", request_id=request_id,
                        ))
                        for emb in topic_embeddings
                    ]
                    try:
                        topic_match_lists = await asyncio.gather(*lookup_tasks)
                    finally:
                        await cancel_and_wait(*lookup_tasks)
                    for matches in topic_match_lists:
                        topic_matches.extend(matches)

            log.info(
                "pipeline_long_path",
                request_id=request_id,
                topics_extracted=len(topics),
                topic_matches=len(topic_matches),
            )

        # Explicit-fetch attribution-flagged refs so they're GUARANTEED in the
        # candidate pool (library ANN top-K is narrow; a short verse-chunk may
        # never enter the pool by cosine alone). Score 0.75 floats them above
        # ordinary fanout but below SHORT's authoritative 0.85.
        if not topic_matches:
            return topic_matches, []
        topic_refs = dedupe_refs(
            list(chain.from_iterable(m.refs for m in topic_matches))
        )
        topic_refs_fetched = await run_stage(
            lambda: fetch_refs(
                topic_refs, chunk_repo=chunk_repo, alias_map=alias_map,
                lang=retrieval_lang_code, canonical_score=0.75, on_event=on_event,
                library_repo=library_repo, catalog_repo=catalog_repo,
                author_scope=author_scope,
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
        # boost refs are pinned at 0.75 without going through the rerank the
        # fanout pool does — gate them against the user question. No-op when no
        # reranker is wired.
        if reranker is not None:
            topic_refs_fetched = await run_stage(
                lambda: gate_topic_refs(
                    topic_refs_fetched, reranker=reranker,
                    question=question, request_id=request_id,
                ),
                default=topic_refs_fetched, timeout=TIMEOUT_FETCH_REFS_S,
                name="gate_topic_refs", request_id=request_id,
            )
        return topic_matches, topic_refs_fetched

    topic_refs_task = asyncio.create_task(_produce_topic_refs())
    try:

        # Step C: fanout, coverage gate, up to N rounds — runs CONCURRENTLY with the
        # topic-refs task above.
        accumulated = FanoutResult()
        queries: list[tuple[int, str]] = (
            _plan_to_fanout_queries(plan) or [(0, question)]
        )

        for round_idx in range(policy.max_fanout_rounds):
            result = await run_stage(
                lambda queries=queries: fanout_search_with_boost(
                    queries=queries,
                    embedder=embedder, chunk_repo=chunk_repo,
                    catalog_repo=catalog_repo, alias_map=alias_map, lang=retrieval_lang_code,
                    author_id=router_args.get("author_id"),
                    location_id=router_args.get("location_id"),
                    tag_ids=router_args.get("tag_ids"),
                    date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
                    date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
                    book_id=router_args.get("source_id"),
                    on_event=on_event,
                    reranker=reranker,
                    rerank_query=question,
                    db_concurrency=fanout_db_concurrency,
                    boost_kinds=boost_kinds_from(
                        question, router_args,
                        author_asked=bool(
                            author_scope is not None
                            and author_scope.selection.constrained
                        ),
                    ),
                    owned_track_ids=owned_track_ids,
                    author_scope=author_scope,
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

            if round_idx + 1 < policy.max_fanout_rounds:
                queries = await run_stage(
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

        # Collect the concurrently-produced topic refs now that the fanout is done.
        topic_matches, topic_refs_fetched = await topic_refs_task
    finally:
        await cancel_and_wait(topic_refs_task)

    # Merge topic-fetched refs with fanout candidates, dedup by _dedup_key,
    # take the top `policy.slate_size` by score. Topic refs have score=0.75;
    # most fanout chunks land 0.45-0.75, so attribution-flagged items naturally
    # float to the top while still letting strongly-matching lectures surface.
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
    # nothing carries `rerank_score` → this is a stable cosine sort.
    def _tier_key(e: dict[str, Any]) -> tuple[int, float]:
        rs = e.get("rerank_score")
        if rs is None:
            return (1, e.get("score") or 0.0)   # authoritative ref tier
        return (0, rs)                           # reranked chunk tier
    top_chunks = _balanced_cut(
        sorted(merged_by_key.values(), key=_tier_key, reverse=True),
        policy.slate_size,
    )

    # Commentary attachment happens after the planner: `synthesis_planner_node`
    # calls `rerank_and_attach_commentaries` per thesis, fetching purports only
    # for verses the planner picked and cosine-reranking them against the
    # thesis text.
    return ResearchResult(
        authoritative_refs=[],
        research_chunks=top_chunks,
        matched_question_ids=[],
        matched_topic_ids=[m.attribution_id for m in topic_matches],
    )
