"""run_research — the orchestrator that replaces the LLM-driven ReAct loop
for `router.intent == "research"` turns.

A sufficiency gate (`research.sufficiency.assess_sufficiency`) buckets the turn
from curated evidence already in hand — a pinned question-attribution OR a strong
memory match → CORRECT, else INCORRECT — and `policy_for` maps the bucket to a
`RetrievalPolicy` preset that drives one of two paths (the legacy SHORT/LONG,
now LEAN/WIDE presets of one policy object):

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
by `_attach_memory` regardless of path.

Every external call is wrapped in `asyncio.wait_for` with a stage-specific
timeout. On timeout: graceful fall-through with partial results, never
block the whole turn.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from itertools import chain
from time import perf_counter
from typing import Any, Callable

from lectorium_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
    resolve_commentary_author_names,
)
from lectorium_chat.indexer.library.repo import fetch_document_body
from lectorium_chat.infra.llm_provider.openrouter import is_provider_unavailable
from lectorium_chat.observability.langfuse_client import langfuse_span
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.attribution_lookup import find_attributions
from lectorium_chat.research.caption_generator import generate_captions
from lectorium_chat.research.constants import (
    BOOST_REF_RERANK_ACCEPT,
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
from lectorium_chat.research.corpus_fanout import (
    emit_library_research_source,
    fanout_search_with_boost,
    merge_fanout,
)
from lectorium_chat.research.kind_intent import boost_kinds_from
from lectorium_chat.research.coverage_gate import (
    is_coverage_good_enough,
    should_bail_out,
)
from lectorium_chat.research.models import (
    AttributionMatch,
    AttributionRef,
    FanoutResult,
    MemoryResolution,
    QueryPlan,
    ResearchResult,
    SubQuery,
)
from lectorium_chat.research.query_planner import plan_queries
from lectorium_chat.research.sufficiency import assess_sufficiency, policy_for
from lectorium_chat.research.topic_extractor import extract_topics


log = get_logger(__name__)


# (event_type, payload) — bridged to the LangGraph stream writer in
# research_worker_node. Pipeline code never knows about SSE.
OnEvent = Callable[[str, dict[str, Any]], None]


# Fallback retrieval language when the answer language has no corpus AND
# a genuine empty-corpus RESULT came back. English is the product's
# guaranteed-present corpus language and always has a partial HNSW index.
_DEFAULT_RETRIEVAL_LANG = "en"

# Static corpus-language set used ONLY when the `distinct_langs` probe
# RAISES (transient Postgres/Redis hiccup) — as opposed to returning an
# empty list. A bare clamp against [] would force English even for a
# Russian turn, silently degrading a ru question to English-only grounding
# on a transient blip. The product's guaranteed corpus languages are en+ru
# (see `Settings.indexer_langs` default "ru,en"); sourced from config when
# one is available, falling back to this literal otherwise.
_PROBE_FAILURE_FALLBACK_LANGS = ("en", "ru")

# Locale → content-language reduction map. The Python mirror of the client
# policy in modules/libs/domain/services/contentLanguage.ts. The UI ships in
# many locales but the corpus carries only a few content languages (today en,
# ru); this map sends each supported UI locale's base subtag to the content
# language it reads in. To extend, add a row (a new East-Slavic UI locale →
# "ru", or a brand-new corpus language → itself) and mirror it on the TS side
# so chat, proactive prompts and the website agree. Any locale not in the map
# falls back to `_DEFAULT_CONTENT_LANG`.
_DEFAULT_CONTENT_LANG = "en"
_LOCALE_CONTENT_LANG: dict[str, str] = {
    "en": "en",
    "ru": "ru",
    "uk": "ru",
}


def reduce_locale_to_content_lang(locale: str) -> str:
    """Base content language a UI locale reduces to, ignoring corpus
    availability — the Python twin of `reduceLocaleToContentLanguage`.
    `uk`/`uk_UA`/`ru-RU` → `ru`; `sr-Latn`/`en-US`/unknown → `en`."""
    base = (locale or "").lower().replace("_", "-").split("-", 1)[0]
    return _LOCALE_CONTENT_LANG.get(base, _DEFAULT_CONTENT_LANG)


def _fallback_corpus_langs() -> list[str]:
    """Best-effort static corpus-language set for a probe FAILURE. Prefers
    the deployment's configured `indexer_langs`; falls back to the literal
    en+ru when config can't be read (never raise — this is itself the
    degradation path)."""
    try:
        from lectorium_chat.config import get_settings

        langs = get_settings().langs
        if langs:
            return langs
    except Exception:  # noqa: BLE001 — config read must never fail the clamp
        pass
    return list(_PROBE_FAILURE_FALLBACK_LANGS)


def clamp_retrieval_lang(answer_lang: str, corpus_langs: list[str]) -> str:
    """Pick the language to RETRIEVE in for a turn whose ANSWER is in
    `answer_lang`.

    Retrieval is strictly single-language and index-bound, so it must run
    in a real corpus language. If the corpus has `answer_lang`, retrieve in
    it (ru→ru, en→en — regression-safe). Otherwise reduce the locale to a
    content language the same way the client does (`uk`→`ru`, everyone else
    →`en`) and use it when the corpus offers it — so a Ukrainian turn cites
    the Russian purport, matching the website and proactive prompts instead
    of dropping to English. Only when even the reduced language is absent do
    we clamp to English. The answer prose stays in `answer_lang` regardless.
    """
    if answer_lang and answer_lang in corpus_langs:
        return answer_lang
    reduced = reduce_locale_to_content_lang(answer_lang)
    if reduced in corpus_langs:
        return reduced
    return _DEFAULT_RETRIEVAL_LANG


async def resolve_retrieval_lang(
    chunk_repo: Any, answer_lang: str, *, request_id: str | None = None
) -> str:
    """Corpus-constrained retrieval language for a turn answering in
    `answer_lang`: probe the corpus languages (`distinct_langs`, cached) and
    `clamp_retrieval_lang`.

    Probe FAILURE vs empty RESULT are handled differently. On an exception
    we clamp against a static fallback set (configured `indexer_langs`, e.g.
    en+ru), so a transient Postgres/Redis hiccup on a Russian turn still
    retrieves natively instead of being silently forced to English-only.
    Only a genuine EMPTY-corpus RESULT (the probe succeeded and returned [])
    clamps to English via `clamp_retrieval_lang`.

    Shared by `research_worker` and `synthesis_planner` so BOTH attach
    purports in the same corpus language. Without it the planner's lazy
    commentary attach used the raw answer language (e.g. `sr-Cyrl`), found
    nothing, and fell back to a stray Russian purport — see
    `commentary_expansion._fetch_one`.
    """
    if chunk_repo is not None and hasattr(chunk_repo, "distinct_langs"):
        try:
            corpus_langs = await chunk_repo.distinct_langs()
        except Exception as exc:  # noqa: BLE001 — never fail a turn
            log.warning("distinct_langs_failed", request_id=request_id, error=str(exc))
            # Probe FAILED (not an empty corpus) — clamp against the static
            # fallback set so `answer_lang` can still retrieve natively.
            return clamp_retrieval_lang(answer_lang, _fallback_corpus_langs())
        return clamp_retrieval_lang(answer_lang, corpus_langs)
    # No probe available at all (no repo / no method) — preserve the legacy
    # static-fallback behaviour rather than blindly forcing English.
    return clamp_retrieval_lang(answer_lang, _fallback_corpus_langs())


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


async def _safe(coro_factory, *, default, timeout: float, name: str, request_id: str | None):
    """Run a coroutine with a stage timeout; on TimeoutError / any exception,
    return `default` so the orchestrator can keep going with partial state.

    Emits `stage_timing {stage, stage_ms, status}` on every outcome so the
    research pipeline is fully covered by the same instrumentation as the
    rest of the turn — without having to wrap each call site separately.
    Also opens a Langfuse span (`retrieval.<stage>`) so the same per-stage
    timing shows up in the trace timeline next to the LLM generations — that
    is where the previously un-instrumented retrieval seconds were hiding.

    EXCEPTION: a provider-availability failure (out of credits / key rejected
    / provider down) is NOT swallowed. Degrading it to `default` here would
    hand the synthesizer empty grounding and produce a confident-looking but
    ungrounded partial answer — worse than telling the user the service is
    momentarily unavailable. It re-raises so `chat_turn` classifies it as a
    calm `chat_unavailable`, not `agent_error`. A transient blip in ONE stage
    (timeout, a single ANN error) still degrades gracefully as before.
    """
    started = perf_counter()
    status = "ok"
    with langfuse_span(f"retrieval.{name}"):
        try:
            return await asyncio.wait_for(coro_factory(), timeout=timeout)
        except asyncio.TimeoutError:
            status = "timeout"
            log.warning("pipeline_stage_timeout", stage=name, timeout=timeout, request_id=request_id)
            return default
        except Exception as exc:  # noqa: BLE001 — best-effort
            if is_provider_unavailable(exc):
                status = "provider_unavailable"
                log.warning(
                    "pipeline_stage_provider_unavailable",
                    stage=name, error=str(exc), request_id=request_id,
                )
                raise
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
            # refs) still gate on the cosine floor, the prior behaviour.
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



async def _fetch_memory_note(pool: Any, attribution_id: str, lang: str) -> str | None:
    """The full note for a matched memory. Prefer the answer language; fall
    back to English, then any language (the synthesizer reads any language and
    still answers in the user's, so a fallback note is fine)."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT note FROM attribution_notes WHERE attribution_id = $1 AND language = $2",
            attribution_id, lang,
        )
        if row is None:
            row = await conn.fetchrow(
                "SELECT note FROM attribution_notes WHERE attribution_id = $1 "
                "ORDER BY (language = 'en') DESC, language LIMIT 1",
                attribution_id,
            )
    return row["note"] if row else None


async def _resolve_memory(
    *,
    user_q_embedding: list[float],
    sub_query_texts: list[str],
    embedder: Any,
    retrieval_lang: str,
    answer_lang: str,
    embed_model: str | None,
    embed_dim: int,
    pool: Any,
    chunk_repo: Any,
    alias_map: Any,
    library_db: Any | None,
    catalog_repo: Any | None,
    on_event: OnEvent | None,
    user_query: str = "",
    reranker: Any = None,
    llm: Any = None,
    confirm_model: str | None = None,
) -> MemoryResolution:
    """Find the best-matching memory for this turn and resolve it.

    The lookup runs against the raw query AND each planner sub-query, taking the
    best match. A paraphrase the raw query embeds too far from a trigger ("как
    устроена Гита") often decomposes into a sub-query ("структура Бхагавад-гиты")
    that matches the trigger strongly — so this widens recall WITHOUT authoring a
    trigger per phrasing, and lifts borderline matches clear of the accept floor.

    The note is injected as non-citable background context; the refs (scoped to
    the answer language) are resolved into citable envelopes folded into the
    pool like boost. The match `score`/`stage` ride along so the sufficiency
    gate can require a STRONGER signal to short-circuit the sweep than the
    (loose) inject threshold. Best-effort — returns an empty `MemoryResolution`
    on no match."""
    if pool is None or not embed_model:
        return MemoryResolution()

    embeddings: list[list[float]] = [user_q_embedding]
    if sub_query_texts and embedder is not None:
        try:
            embeddings.extend(await embedder.embed_queries(sub_query_texts))
        except Exception as exc:  # noqa: BLE001 — best-effort
            log.warning("memory_subquery_embed_failed", error=str(exc))

    top: AttributionMatch | None = None
    for emb in embeddings:
        matches = await find_attributions(
            kind="memory", user_q_embedding=emb, lang=retrieval_lang,
            embed_model=embed_model, embed_dim=embed_dim, pool=pool,
            reranker=reranker, user_query=user_query,
            llm=llm, confirm_model=confirm_model,
        )
        if matches and (top is None or matches[0].score > top.score):
            top = matches[0]
    if top is None:
        return MemoryResolution()
    note = await _fetch_memory_note(pool, top.attribution_id, retrieval_lang)
    # Keep refs that are language-agnostic OR scoped to this answer language
    # (e.g. drop the EN lecture ref when answering in RU).
    scoped_refs = [r for r in top.refs if not r.language or r.language == answer_lang]
    envelopes: list[dict[str, Any]] = []
    if scoped_refs:
        envelopes = await _fetch_refs(
            scoped_refs, chunk_repo=chunk_repo, alias_map=alias_map,
            lang=retrieval_lang, canonical_score=MEMORY_REF_SCORE, on_event=on_event,
            library_db=library_db, catalog_repo=catalog_repo,
        )
    log.info(
        "pipeline_memory_match",
        attribution_id=top.attribution_id,
        score=round(top.score, 3),
        stage=top.stage,
        has_note=note is not None,
        refs=len(envelopes),
    )
    return MemoryResolution(
        note=note,
        attribution_id=top.attribution_id,
        envelopes=envelopes,
        score=top.score,
        stage=top.stage,
    )


def _attach_memory(result: ResearchResult, mem: MemoryResolution) -> ResearchResult:
    """Fold a resolved memory onto a ResearchResult: the note rides as
    non-citable background; the refs are AUTHORITATIVE.

    A memory's refs are curator-picked (a human deliberately selected exactly
    these shlokas for exactly this note), so they ride with `authoritative_refs`
    — pinned ahead of the reranked fanout pool — rather than being thrown into
    the pool and reranked against ordinary chunks where the planner can drop
    them. The note builds the theses; these refs are their intended evidence."""
    result.memory_note = mem.note
    result.matched_memory_id = mem.attribution_id
    if mem.envelopes:
        result.authoritative_refs = list(result.authoritative_refs) + mem.envelopes
    return result


async def _fetch_refs(
    refs: list[AttributionRef],
    *,
    chunk_repo: Any,
    alias_map: Any,
    lang: str | None,
    canonical_score: float,
    on_event: OnEvent | None = None,
    library_db: Any | None = None,
    catalog_repo: Any | None = None,
) -> list[dict[str, Any]]:
    """Resolve each AttributionRef → chunks → envelopes. Envelopes carry
    `score = canonical_score` (>= 0.85 for accept) so the synthesizer's
    refusal-discipline doesn't drop them as junk.

    For lectures, ref_kind="document" with kind='letter' / 'commentary' /
    'prose_chapter' applies; refs to literal verses use kind='verse'."""
    if not refs:
        return []

    async def _one(ref: AttributionRef) -> list[dict[str, Any]]:
        # Lecture-fragment refs resolve to transcript chunks (which have no
        # item_id/addr_label), so they take the lecture envelope path, not the
        # library one. target_id = "<track_id>@<start_ms>-<end_ms>".
        if ref.ref_kind == "track":
            return await _one_track(ref)
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
        # Resolve commentary author_id → human name (e.g. "А. Ч. Бхактиведанта
        # Свами Прабхупада") so a pinned commentary's blockquote carries its
        # author, not just the address. The fanout + commentary_expansion paths
        # already do this; authoritative refs skipped it, so a pinned purport
        # rendered as "— БГ 2.13" with no author. Best-effort (empty map when no
        # catalog / non-commentary chunks).
        author_names = await resolve_commentary_author_names(
            chunks, catalog_repo=catalog_repo, lang=lang,
        )

        def _author_meta(c: Any) -> dict[str, Any] | None:
            name = author_names.get(c.author_id) if c.author_id else None
            return {"author_name": name} if name else None

        # Document refs (commentary / prose_chapter / letter): cite the
        # WHOLE document as ONE source, from its canonical library.db body —
        # NOT reassembled from the overlapping Postgres search chunks (which
        # repeat text at segment boundaries and, for some imports, carry
        # duplicated paragraphs). Falls back to the chunk path if the body
        # isn't available. Verse refs always take the chunk path.
        if ref.ref_kind == "document" and library_db is not None and chunks:
            head = chunks[0]
            body = await fetch_document_body(library_db, head.item_id, lang or head.lang)
            if body:
                emit_library_research_source(on_event, item_kind=head.item_kind, chunk=head)
                full = replace(head, text=body, segment_index=0)
                env = library_to_envelope(
                    full, alias_map=alias_map, score=canonical_score,
                    extra_meta=_author_meta(head),
                )
                env["_dedup_key"] = (head.item_kind, head.item_id, 0)
                return [env]

        envelopes: list[dict[str, Any]] = []
        for c in chunks:
            # Surface the consulted source with its real (normalized) label
            # now that the chunk — and its addr_label — has loaded. Shares
            # the `verse:`/`library:` id namespace with the fanout path, so
            # the client's dedup-by-id collapses a source seen by both.
            emit_library_research_source(on_event, item_kind=c.item_kind, chunk=c)
            env = library_to_envelope(
                c, alias_map=alias_map, score=canonical_score,
                extra_meta=_author_meta(c),
            )
            # Same shape as fanout's _library_dedup_key so merge_fanout-style
            # callers can dedup these alongside fanout output.
            env["_dedup_key"] = (c.item_kind, c.item_id, c.segment_index)
            envelopes.append(env)
        return envelopes

    async def _one_track(ref: AttributionRef) -> list[dict[str, Any]]:
        try:
            chunks = await chunk_repo.get_chunks_by_track_fragment(
                target_id=ref.target_id, lang=lang,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "fetch_refs_track_failed",
                target_id=ref.target_id, error=str(exc),
            )
            return []
        # Native-lang fallback, mirroring the library path above.
        if not chunks and lang is not None:
            try:
                chunks = await chunk_repo.get_chunks_by_track_fragment(
                    target_id=ref.target_id, lang=None,
                )
            except Exception:  # noqa: BLE001
                chunks = []
        envelopes: list[dict[str, Any]] = []
        for c in chunks:
            # lecture_to_envelope mints the cite alias the client dedups on.
            # _dedup_key mirrors corpus_fanout's _lecture_dedup_key shape so
            # merge_fanout collapses a fragment surfaced by both attribution
            # and fanout (the helper is private to corpus_fanout, so inline).
            env = lecture_to_envelope(c, alias_map=alias_map, score=canonical_score)
            env["_dedup_key"] = ("lecture", c.track_id, c.start_ms, c.end_ms)
            envelopes.append(env)
        return envelopes

    per_ref = await asyncio.gather(*(_one(r) for r in refs), return_exceptions=False)
    flat: list[dict[str, Any]] = []
    for batch in per_ref:
        flat.extend(batch)

    # Title refs are intentionally NOT surfaced as a chapter card here: the
    # ChapterCard renders poorly on mobile and the chapter pointer added noise
    # to the answer. The title→chapter resolver (`build_pinned_chapter_notes`)
    # is kept for potential reuse, but a pinned `title` ref is a no-op in the
    # research path — only its verse refs render (as verse cards). Verse refs in
    # the same attribution still come from the per-ref loop above.

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
    retrieval_lang: str | None = None,   # corpus-constrained retrieval lang
    chunk_repo: Any,                     # ChunkRepository
    catalog_repo: Any,                   # CatalogRepository
    embedder: Any,                       # EmbedderPort
    alias_map: Any,                      # TurnAliasMap (ctx.aliases)
    pool: Any,                           # asyncpg pool
    llm: Any,                            # LLMPort
    embed_model: str,                    # settings.embed_model
    embed_dim: int,                      # settings.embed_dim — selects attribution_emb_d{N} table
    library_db: Any | None = None,       # Path to library.db snapshot — full document bodies for pinned doc refs
    expand_model: str | None = None,
    topic_model: str | None = None,
    confirm_model: str | None = None,
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
    # ACL for the private per-user lecture lane (#1227): the set of
    # `user_track` ids this user owns, resolved server-side from the `owned`
    # projection keyed on the JWT `sub`. None / empty ⇒ the private lane is
    # off and retrieval is the public corpus only.
    owned_track_ids: list[str] | None = None,
) -> ResearchResult:
    """Code-driven research. Called from `research_worker_node` when
    `router.intent == "research"`.

    `on_event` (optional) is a sync `(event_type, payload)` callback the
    pipeline uses to surface sub-queries and inspected sources to the
    client in real-time, BEFORE ranking/dedup. The node bridges it onto
    LangGraph's stream writer. Pure observability — never blocks or
    raises into the research loop.

    `retrieval_lang` is the corpus-constrained language EVERY retrieval lane
    (fanout, ref-fetch, attribution lookup, address fast-path) runs in. It
    is always a real corpus language (the worker derives it via
    `clamp_retrieval_lang`); `lang` (the answer language) drives the planner
    / topic-extraction / caption prose only. Defaulting to `lang` keeps
    legacy callers (tests) on the old single-lang behaviour."""

    if retrieval_lang is None:
        retrieval_lang = lang

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
            question=question, lang=lang, retrieval_lang=retrieval_lang,
            plan=QueryPlan(sub_queries=[
                SubQuery(id=0, type="general", text=question, alt_phrasings=[]),
            ]),
            chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
            alias_map=alias_map, llm=llm, router_args=router_args,
            expand_model=expand_model,
            library_db=library_db,
            request_id=request_id, on_event=on_event,
            reranker=reranker,
            callbacks=callbacks,
            owned_track_ids=owned_track_ids,
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
            kind="pinned", user_q_embedding=user_q_embedding, lang=retrieval_lang,
            embed_model=embed_model, embed_dim=embed_dim,
            pool=pool, reranker=reranker, user_query=question,
            llm=llm, confirm_model=confirm_model,
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
    memory_task = asyncio.create_task(_safe(
        lambda: _resolve_memory(
            user_q_embedding=user_q_embedding, sub_query_texts=sub_query_texts,
            embedder=embedder, retrieval_lang=retrieval_lang,
            answer_lang=lang, embed_model=embed_model, embed_dim=embed_dim,
            pool=pool, chunk_repo=chunk_repo, alias_map=alias_map,
            library_db=library_db, catalog_repo=catalog_repo, on_event=on_event,
            user_query=question, reranker=reranker, llm=llm, confirm_model=confirm_model,
        ),
        default=MemoryResolution(),
        timeout=TIMEOUT_MEMORY_LOOKUP_S,
        name="memory_lookup", request_id=request_id,
    ))

    # 2. SUFFICIENCY GATE. Await the curated memory match and decide BEFORE the
    # wide fanout whether curated authoritative evidence already answers the
    # turn. A pinned question-attribution is the legacy SHORT trigger; a strong
    # memory match is now ALSO a CORRECT trigger — so a memory-answered turn
    # takes the lean path instead of paying the full WIDE corpus sweep (100-200
    # sources). This is the latency seam the binary SHORT/LONG fork left open.
    #
    # NOTE on cost: memory_task is created only AFTER the plan resolves (it
    # consumes the plan's sub-queries), so it does NOT overlap the plan; and it
    # was previously awaited AFTER the fork, hidden under fanout. Awaiting it
    # here moves the lookup onto the pre-fork critical path. The gate genuinely
    # needs the result to choose the path, so this is inherent — but the cost is
    # small in practice: the lookup overlaps the still-running speculative
    # topic_task, and the eval measured WIDE-bucket latency flat. It is small,
    # not free.
    memory_result = await memory_task
    bucket = assess_sufficiency(question_matches, memory_result)
    policy = policy_for(bucket)

    if not policy.wide_fanout:
        # Topic extraction was speculative; the lean path doesn't use it.
        if topic_task is not None:
            topic_task.cancel()
            topic_task = None
        result = await _lean_path(
            policy=policy,
            question_matches=question_matches,
            memory_envelopes=memory_result.envelopes,
            plan=plan, question=question, lang=lang, retrieval_lang=retrieval_lang,
            chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
            alias_map=alias_map, llm=llm, router_args=router_args,
            expand_model=expand_model, library_db=library_db,
            request_id=request_id, on_event=on_event, reranker=reranker,
            owned_track_ids=owned_track_ids,
        )
        _attach_memory(result, memory_result)
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
        except (asyncio.CancelledError, Exception):
            speculative_topics = []
    long_result = await _research_path(
        policy=policy,
        question=question, lang=lang, retrieval_lang=retrieval_lang, plan=plan,
        chunk_repo=chunk_repo, catalog_repo=catalog_repo, embedder=embedder,
        alias_map=alias_map, llm=llm, router_args=router_args,
        expand_model=expand_model,
        topic_model=topic_model, embed_model_for_lookup=embed_model,
        embed_dim_for_lookup=embed_dim, pool=pool,
        library_db=library_db,
        request_id=request_id, on_event=on_event,
        precomputed_topics=speculative_topics,
        kv_cache=kv_cache,
        reranker=reranker,
        callbacks=callbacks,
        owned_track_ids=owned_track_ids,
    )
    _attach_memory(long_result, memory_result)
    _kick_caption_gen(
        long_result, alias_map=alias_map, question=question, lang=lang,
        llm=llm, model=expand_model, request_id=request_id,
        callbacks=callbacks,
    )
    return long_result


async def _lean_path(
    *,
    policy: RetrievalPolicy,
    question_matches: list[AttributionMatch],
    memory_envelopes: list[dict[str, Any]] | None = None,
    plan: QueryPlan,
    question: str,
    lang: str,
    retrieval_lang: str,
    chunk_repo: Any,
    catalog_repo: Any,
    embedder: Any,
    alias_map: Any,
    llm: Any,
    router_args: dict[str, Any],
    expand_model: str | None,
    library_db: Any | None,
    request_id: str | None,
    on_event: OnEvent | None,
    reranker: Any,
    owned_track_ids: list[str] | None = None,
) -> ResearchResult:
    """Lean retrieval taken whenever the sufficiency gate returns CORRECT —
    a pinned question-attribution (legacy SHORT) OR a strong memory match (new).

    Curated authoritative refs are PINNED ahead of a bounded supplementary
    fanout. On a pinned match the question-attribution refs are fetched here; on
    a memory-only CORRECT there are no pinned refs (the memory's own shlokas are
    folded in by `_attach_memory` in the caller). `memory_envelopes` (the
    already-resolved memory refs) are passed in so the supplementary dedup can
    suppress fragments of memory-pinned documents even though the attach happens
    later. Either way the supplementary fanout explores the canonical theme
    around the curated core without the full WIDE corpus sweep."""
    # Pinned question-attribution refs (empty on a memory-only CORRECT).
    all_refs = _dedupe_refs(
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
    authoritative, supplementary = await asyncio.gather(
        _safe(
            lambda: _fetch_refs(
                all_refs, chunk_repo=chunk_repo, alias_map=alias_map,
                lang=retrieval_lang, canonical_score=top_score, on_event=on_event,
                library_db=library_db, catalog_repo=catalog_repo,
            ),
            default=[], timeout=TIMEOUT_FETCH_REFS_S,
            name="fetch_refs", request_id=request_id,
        ),
        _safe(
            lambda: fanout_search_with_boost(
                queries=supplementary_queries,
                embedder=embedder, chunk_repo=chunk_repo,
                catalog_repo=catalog_repo, alias_map=alias_map, lang=retrieval_lang,
                author_id=router_args.get("author_id"),
                location_id=router_args.get("location_id"),
                tag_ids=router_args.get("tag_ids"),
                date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
                date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
                book_id=router_args.get("source_id"),
                on_event=on_event,
                reranker=reranker,
                rerank_query=question,
                boost_kinds=boost_kinds_from(question, router_args),
                owned_track_ids=owned_track_ids,
            ),
            default=FanoutResult(), timeout=TIMEOUT_FANOUT_S,
            name="supplementary_fanout", request_id=request_id,
        ),
    )

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
    # result by `_attach_memory` AFTER this function returns. Without them here, a
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
    # Commentary attachment moved POST-planner: `synthesis_planner_node` calls
    # `rerank_and_attach_commentaries` for verses the planner actually picked.
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
        # NOTE: the fragment transcript for `flush_cite_payloads` is now
        # stashed at mint time in `lecture_to_envelope`
        # (alias_map.chunk_texts[ref] = chunk.text), the single choke point
        # for every cite-able lecture ref. This loop only builds caption
        # targets; it no longer writes chunk_texts.

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


async def _gate_topic_refs(
    envelopes: list[dict[str, Any]],
    *,
    reranker: Any,
    question: str,
    request_id: str | None,
) -> list[dict[str, Any]]:
    """Cross-encoder gate for fetched boost (topic-attribution) refs.

    boost refs are pinned at a flat 0.75 cosine that floats them above
    ordinary fanout, but — unlike the fanout pool — they never go through the
    reranker. A topic that matched only a tangential angle of the question
    therefore gets seated above on-topic fanout chunks. When a reranker is
    present, re-score each ref's TEXT against the USER QUESTION and drop the
    ones below `BOOST_REF_RERANK_ACCEPT`. Survivors keep their 0.75 `score`
    (so the downstream two-tier sort is unchanged for the kept set).

    Conservative by construction: no reranker, no usable texts, or a reranker
    error all pass the refs through untouched — the normal fanout path is
    never touched, and a gate failure can only ADD refs back, never silently
    drop a curated decision on infra trouble.
    """
    if reranker is None or not envelopes:
        return envelopes
    texts = [(e.get("text") or "").strip() for e in envelopes]
    if not any(texts):
        return envelopes
    try:
        scored = await reranker.rerank(question, texts)
    except Exception as exc:  # noqa: BLE001 — a turn never fails on the reranker
        log.warning("topic_ref_rerank_failed", error=str(exc), request_id=request_id)
        return envelopes
    score_by_idx = {idx: rs for idx, rs in scored}
    kept: list[dict[str, Any]] = []
    for i, env in enumerate(envelopes):
        rs = score_by_idx.get(i)
        # An index the reranker omitted (its own top_k) is treated as below
        # the bar — it ranked outside the kept set.
        if rs is not None and rs >= BOOST_REF_RERANK_ACCEPT:
            kept.append(env)
    log.info(
        "topic_refs_gated",
        request_id=request_id,
        before=len(envelopes),
        after=len(kept),
    )
    return kept


async def _research_path(
    *,
    policy: RetrievalPolicy = WIDE_POLICY,
    question: str,
    lang: str,
    retrieval_lang: str | None = None,
    plan: QueryPlan,
    chunk_repo: Any,
    catalog_repo: Any,
    embedder: Any,
    alias_map: Any,
    llm: Any,
    router_args: dict[str, Any],
    expand_model: str | None,
    topic_model: str | None = None,
    embed_model_for_lookup: str | None = None,
    embed_dim_for_lookup: int | None = None,
    pool: Any | None = None,
    library_db: Any | None = None,
    request_id: str | None = None,
    on_event: OnEvent | None = None,
    precomputed_topics: list[str] | None = None,
    kv_cache: Any | None = None,
    reranker: Any = None,
    callbacks: list[Any] | None = None,
    owned_track_ids: list[str] | None = None,
) -> ResearchResult:
    """WIDE path: topic-extract → topic-lookup → fanout with coverage gate
    and up to `policy.max_fanout_rounds` rounds (default WIDE_POLICY).

    `retrieval_lang` (corpus-constrained) drives every retrieval call;
    `lang` (answer language) drives the topic-extraction prose only.
    Defaults to `lang` for legacy callers."""
    if retrieval_lang is None:
        retrieval_lang = lang
    # Topic-attribution refs (extract → embed → lookup → fetch → gate) are
    # INDEPENDENT of the fanout: the fanout's only inputs are the plan queries +
    # boost_kinds(question, router_args) — never topic_matches — and the two
    # outputs are merged below by keyed dedup (order-independent). So produce the
    # topic refs in a task that runs CONCURRENTLY with the fanout loop instead of
    # serially before it, hiding the topic embed+lookup+fetch+gate latency under
    # the fanout (measured ~1s / ~22% off the WIDE research-stage wall). Both
    # touch alias_map / on_event, which is asyncio-safe (alias minting is
    # synchronous between awaits); only the research_source event order
    # interleaves, which the client dedups by id.
    async def _produce_topic_refs() -> tuple[list[AttributionMatch], list[dict[str, Any]]]:
        topic_matches: list[AttributionMatch] = []
        if (
            pool is not None
            and embed_model_for_lookup is not None
            and embed_dim_for_lookup is not None
        ):
            # Step A: LLM extracts topics from the question. Use the
            # speculative result from `run_research` if it's available
            # (already paid for under `plan_queries` latency); otherwise
            # extract synchronously here.
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
            if topics:
                topic_embeddings: list[list[float]] = await _safe(
                    lambda: embedder.embed_queries(topics),
                    default=[], timeout=TIMEOUT_TOPIC_LOOKUP_S,
                    name="embed_topics", request_id=request_id,
                )
                if topic_embeddings:
                    lookup_tasks = [
                        _safe(
                            lambda emb=emb: find_attributions(
                                kind="boost", user_q_embedding=emb, lang=retrieval_lang,
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
        topic_refs = _dedupe_refs(
            list(chain.from_iterable(m.refs for m in topic_matches))
        )
        topic_refs_fetched = await _safe(
            lambda: _fetch_refs(
                topic_refs, chunk_repo=chunk_repo, alias_map=alias_map,
                lang=retrieval_lang, canonical_score=0.75, on_event=on_event,
                library_db=library_db, catalog_repo=catalog_repo,
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
            topic_refs_fetched = await _safe(
                lambda: _gate_topic_refs(
                    topic_refs_fetched, reranker=reranker,
                    question=question, request_id=request_id,
                ),
                default=topic_refs_fetched, timeout=TIMEOUT_FETCH_REFS_S,
                name="gate_topic_refs", request_id=request_id,
            )
        return topic_matches, topic_refs_fetched

    topic_refs_task = asyncio.create_task(_produce_topic_refs())

    # Step C: fanout, coverage gate, up to N rounds — runs CONCURRENTLY with the
    # topic-refs task above.
    accumulated = FanoutResult()
    queries: list[tuple[int, str]] = (
        _plan_to_fanout_queries(plan) or [(0, question)]
    )

    for round_idx in range(policy.max_fanout_rounds):
        result = await _safe(
            lambda queries=queries: fanout_search_with_boost(
                queries=queries,
                embedder=embedder, chunk_repo=chunk_repo,
                catalog_repo=catalog_repo, alias_map=alias_map, lang=retrieval_lang,
                author_id=router_args.get("author_id"),
                location_id=router_args.get("location_id"),
                tag_ids=router_args.get("tag_ids"),
                date_from=router_args.get("date_from") or router_args.get("doc_date_from"),
                date_to=router_args.get("date_to") or router_args.get("doc_date_to"),
                book_id=router_args.get("source_id"),
                on_event=on_event,
                reranker=reranker,
                rerank_query=question,
                boost_kinds=boost_kinds_from(question, router_args),
                owned_track_ids=owned_track_ids,
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

    # Collect the concurrently-produced topic refs now that the fanout is done.
    topic_matches, topic_refs_fetched = await topic_refs_task

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
    # nothing carries `rerank_score` → this is a stable cosine sort, same
    # as before.
    def _tier_key(e: dict[str, Any]) -> tuple[int, float]:
        rs = e.get("rerank_score")
        if rs is None:
            return (1, e.get("score") or 0.0)   # authoritative ref tier
        return (0, rs)                           # reranked chunk tier
    top_chunks = _balanced_cut(
        sorted(merged_by_key.values(), key=_tier_key, reverse=True),
        policy.slate_size,
    )

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
