"""Corpus-fallback node — the out-of-corpus "memory-pass".

Runs when `synthesis_planner` flagged `corpus_insufficient` (the corpus held
nothing relevant for the question). Instead of the flat «не нашёл в корпусе»
refusal, this node:

1. Asks a capable model (Claude by default) the question FROM GENERAL
   KNOWLEDGE, and — in the same structured call — has it derive a handful of
   corpus search probes from its own answer.
2. Re-searches the corpus on those probes (best-effort enrichment), keeping
   only notes that clear a score floor — the original query already retrieved
   (and the planner rejected) the junk pool, so we admit only what the
   reframed probes surface with real signal.
3. Hands the synthesizer the draft answer + any surviving notes. The
   synthesizer runs in `fallback_mode` (see `synthesizer_node`): it opens with
   the mandatory disclaimer, presents the draft faithfully, and weaves `[^N]`
   citations only where the re-searched notes genuinely support a point.

Graceful degrade: no LLM / structured call fails / empty answer → return `{}`
so the synthesizer runs the normal refusal (today's behaviour). Re-search
failure → memory-only answer (still valid, just uncited).
"""

from __future__ import annotations

from typing import Literal

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime
from pydantic import BaseModel, Field

from lectorium_chat.agent.graph.nodes._worker_common import (
    flush_card_payloads,
    translate_commentaries,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.config import get_settings
from lectorium_chat.observability.langfuse_client import langfuse_node_callback
from lectorium_chat.observability.logging import bind_node_role, get_logger
from lectorium_chat.observability.metrics import corpus_fallback_counter
from lectorium_chat.research.corpus_fanout import (
    dedup_notes_by_key,
    fanout_search_with_boost,
)
from lectorium_chat.research.models import ResearchNote
from lectorium_chat.research.pipeline import resolve_retrieval_lang


log = get_logger(__name__)


# Re-searched chunks must clear this score to be cited. The original query
# already retrieved (and the planner rejected) the junk pool; only admit notes
# the reframed probes surface with real signal — a lower floor would re-import
# the same junk under the disclaimer.
_FALLBACK_MIN_SCORE = 0.5
_MAX_SUBQUERIES = 5


class MemoryAnswer(BaseModel):
    """Structured memory-pass result: the from-knowledge answer plus the
    corpus probes derived from it, gated by scope + self-assessed confidence.

    `in_scope` and `confidence` are cheap signals from the SAME generation call
    — not a faithfulness judge (a model grading its own facts is self-preference
    bias). Scope classification is objective and reliable even self-reported;
    confidence is only used to hedge wording, never as a truth gate. Real
    faithfulness validation is offline + cross-model (see tests/evals)."""

    in_scope: bool = Field(
        description=(
            "True if the question concerns this assistant's subject area in ANY "
            "way — Gauḍīya Vaiṣṇava philosophy and theology, Kṛṣṇa and His "
            "associates (the gopīs, the mañjarīs, Rādhā…), the deities, holy "
            "places, devotees, Vedic scripture, bhakti practice, OR Śrīla "
            "Prabhupāda's life, history and teachings. Niche, obscure, or "
            "hard-to-answer spiritual questions are STILL in scope — answer with "
            "low confidence, do NOT decline. Set False ONLY for genuinely "
            "unrelated everyday subjects (cooking, sports, programming, politics, "
            "celebrity/news) that have nothing to do with the tradition."
        )
    )
    confidence: Literal["high", "medium", "low"] = Field(
        description=(
            "Your confidence that `answer` reflects established tradition rather "
            "than guesswork: 'high' = well-known, 'low' = you are largely "
            "guessing. Used only to calibrate how much the reply hedges."
        )
    )
    disclaimer: str = Field(
        default="",
        description=(
            "ONE short sentence IN THE USER'S LANGUAGE saying that the corpus of "
            "lectures and books had nothing on this and you are answering from "
            "general knowledge / memory. This is shown to the user verbatim "
            "before your answer. Leave empty if `in_scope` is false."
        ),
    )
    answer: str = Field(
        description=(
            "A direct, faithful answer to the question from your general "
            "knowledge, in the user's language. Be accurate and measured; do "
            "NOT invent scripture references, verse numbers, or quotes. If you "
            "are unsure, say so plainly rather than fabricate. Leave empty if "
            "`in_scope` is false."
        )
    )
    # No `max_length` here: it renders as JSON-schema `maxItems`, which
    # Anthropic's structured-output endpoint rejects. The node caps the list
    # to `_MAX_SUBQUERIES` after the fact.
    search_queries: list[str] = Field(
        default_factory=list,
        description=(
            "1-5 short search queries derived from your answer, used to look "
            "for supporting material in a corpus of Śrīla Prabhupāda's "
            "lectures and books. Phrase them as the topics/concepts your "
            "answer rests on, in the user's language."
        ),
    )


_MEMORY_PASS_SYSTEM = (
    "You are a knowledgeable assistant on Gauḍīya Vaiṣṇava philosophy, ISKCON, "
    "and the teachings of Śrīla Prabhupāda. The user's question could not be "
    "answered from the lecture/book corpus. First judge `in_scope`: anything "
    "about the tradition — its philosophy, Kṛṣṇa and His associates (incl. the "
    "gopīs and mañjarīs), the deities, scripture, bhakti, or Prabhupāda's life — "
    "is IN scope even if niche or obscure (answer it, just set low confidence). "
    "Only a genuinely unrelated everyday topic (cooking, sports, code, news) is "
    "OUT of scope: then set in_scope=false and leave `answer`/`disclaimer` empty. "
    "If IN scope, answer from your own general knowledge in the user's language "
    "({lang}), write a one-sentence `disclaimer` (in {lang}) that this comes from "
    "memory not the corpus, set `confidence` honestly, and never fabricate verse "
    "numbers, quotes, dates, or attributed statements. Then derive "
    "`search_queries`: the concepts your answer relies on, so the system can look "
    "for corroborating passages in the corpus."
)


async def corpus_fallback_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("corpus_fallback")
    ctx = runtime.context

    if ctx.llm is None:
        log.warning("corpus_fallback_skip_no_llm", request_id=ctx.request_id)
        corpus_fallback_counter.labels(
            kind="degraded", confidence="na", had_corpus_hits="no"
        ).inc()
        return {}

    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "consulting_general_knowledge"}})

    user_query = state.get("user_query", "")
    lang = state.get("lang", "ru")
    settings = get_settings()
    cb = (
        langfuse_node_callback(ctx.langfuse_trace_id, "corpus_fallback")
        if ctx.langfuse_trace_id
        else None
    )

    # 1. Memory-pass: answer from general knowledge + derive corpus probes.
    messages = [
        {"role": "system", "content": _MEMORY_PASS_SYSTEM.format(lang=lang)},
        {"role": "user", "content": user_query},
    ]
    try:
        mem = await ctx.llm.structured_output(
            messages,
            MemoryAnswer,
            model=settings.llm_fallback_knowledge,
            callbacks=[cb] if cb is not None else None,
            run_name="corpus_fallback_memory",
        )
    except Exception as exc:  # noqa: BLE001 — degrade to the normal refusal
        log.warning(
            "corpus_fallback_memory_failed",
            request_id=ctx.request_id,
            error=str(exc),
        )
        corpus_fallback_counter.labels(
            kind="degraded", confidence="na", had_corpus_hits="no"
        ).inc()
        return {}

    # Off-topic for this assistant (cooking, sports, code…). Decline politely
    # — do NOT answer from memory and do NOT pretend the corpus simply missed.
    if not mem.in_scope:
        log.info(
            "corpus_fallback_out_of_scope",
            request_id=ctx.request_id,
            q_chars=len(user_query),
        )
        corpus_fallback_counter.labels(
            kind="out_of_scope", confidence="na", had_corpus_hits="no"
        ).inc()
        return {
            "fallback_mode": True,
            "fallback_kind": "out_of_scope",
            "fallback_answer": "",
            "fallback_notes": [],
            "outline": None,
        }

    answer = (mem.answer or "").strip()
    if not answer:
        log.warning("corpus_fallback_empty_answer", request_id=ctx.request_id)
        corpus_fallback_counter.labels(
            kind="degraded", confidence="na", had_corpus_hits="no"
        ).inc()
        return {}

    # 2. Re-search the corpus on the model-derived probes (best-effort).
    fresh_notes: list[ResearchNote] = []
    queries = [q.strip() for q in (mem.search_queries or []) if q and q.strip()]
    queries = queries[:_MAX_SUBQUERIES]
    if queries and ctx.chunk_repo and ctx.embedder and ctx.catalog_repo:
        try:
            retrieval_lang = await resolve_retrieval_lang(
                ctx.chunk_repo, lang, request_id=ctx.request_id
            )
            ctx.retrieval_lang = retrieval_lang
            enable_reranker = state.get("config", {}).get("enable_reranker", True)
            reranker = ctx.reranker if enable_reranker else None
            result = await fanout_search_with_boost(
                list(enumerate(queries)),
                embedder=ctx.embedder,
                chunk_repo=ctx.chunk_repo,
                catalog_repo=ctx.catalog_repo,
                alias_map=ctx.aliases,
                lang=retrieval_lang,
                reranker=reranker,
                rerank_query=user_query,
            )
            survivors = [
                c
                for c in result.chunks
                if isinstance(c, dict)
                and float(c.get("score") or 0.0) >= _FALLBACK_MIN_SCORE
            ]
            fresh_notes = dedup_notes_by_key(survivors)
        except Exception as exc:  # noqa: BLE001 — citations never fail the turn
            log.warning(
                "corpus_fallback_research_failed",
                request_id=ctx.request_id,
                error=str(exc),
            )
            fresh_notes = []

    # Flush verse/cite card payloads minted by the re-search BEFORE the
    # synthesizer streams their `[^N]` markers (mirror research_worker).
    if fresh_notes:
        await flush_card_payloads(ctx)
        await translate_commentaries(ctx)

    log.info(
        "corpus_fallback_complete",
        request_id=ctx.request_id,
        confidence=mem.confidence,
        answer_chars=len(answer),
        n_queries=len(queries),
        n_notes=len(fresh_notes),
    )
    corpus_fallback_counter.labels(
        kind="memory",
        confidence=mem.confidence,
        had_corpus_hits="yes" if fresh_notes else "no",
    ).inc()

    update: dict = {
        "fallback_mode": True,
        "fallback_kind": "memory",
        "fallback_answer": answer,
        "fallback_confidence": mem.confidence,
        # Localized disclaimer, painted deterministically by the synthesizer
        # (the model can't be trusted to always reproduce the mandatory line).
        "fallback_disclaimer": (mem.disclaimer or "").strip(),
        "fallback_notes": fresh_notes,
        # Free-form synthesis — the fallback prompt drives structure, not a plan.
        "outline": None,
    }
    return update
