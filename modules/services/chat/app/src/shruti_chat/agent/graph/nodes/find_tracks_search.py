"""Find-tracks search: the semantic lecture search under a filter set, the
other-language and near-miss fan-outs, and the one-card-per-track cut.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass

from shruti_chat.agent.graph.nodes.find_tracks_filters import (
    NEVER_ALONE,
    stated_constraints,
    without,
)
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.domain.entities import ScoredChunk
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.retrieval_lang import fallback_corpus_langs

log = get_logger(__name__)


# At most five lecture cards — the user scans a short, scannable list and adds
# one to a playlist; beyond that it stops being useful.
_MAX_LECTURES = 5
# Pull well over `_MAX_LECTURES` chunks so grouping-by-track still yields a
# full list AND leaves a non-intro chunk to quote per track.
_SEARCH_TOP_K = 24
# Cosine floor — below this the lecture isn't really "about" the query; we'd
# rather show fewer cards than an off-topic one. Matches chunks_search.
_MIN_SCORE = 0.45
# Chunks starting in the first minute are the lecture's standard opening
# ("Лекция по ШБ … итак, зачитайте"). Never quote those when a real passage
# exists.
_INTRO_MS = 60_000


async def search_lectures(
    ctx: TurnContext, embedding: list[float], flt: dict, *, lang: str | None,
) -> list[ScoredChunk]:
    """Semantic search under `flt`. `lang=None` drops the transcript-language
    predicate, so lectures that exist ONLY in another language become visible.

    The turn's author selection narrows EVERY rung of the ladder and is never
    relaxed by it: a person who limited the answer to one lecturer must not be
    handed another one's lecture — the ladder gives up the author a QUESTION
    named, not the one a setting did."""
    eligible = None
    if any(flt.values()):
        eligible = await ctx.catalog_repo.filter_track_ids(**flt)
    if ctx.author_scope is not None:
        eligible = await ctx.author_scope.narrow(eligible)
    if eligible is not None and not eligible:
        return []  # filters matched zero tracks — nothing to search
    return await ctx.chunk_repo.search_by_embedding(
        embedding,
        eligible_track_ids=eligible,
        lang=lang,
        top_k=_SEARCH_TOP_K,
    )


@dataclass(frozen=True)
class Found:
    """What the search settled on, and what it cost to get there."""

    lectures: list[ScoredChunk]
    relaxed: str = ""          # constraints given up, comma-joined
    other_language: bool = False
    partial: bool = False      # each lecture misses ONE of `relaxed`, not all


async def try_search(
    ctx: TurnContext, embedding: list[float], flt: dict, *, lang: str | None,
    floor: float = _MIN_SCORE,
) -> list[ScoredChunk]:
    """One search. A search that fails counts as a search that found nothing.

    Every other lookup in this worker works the same way — the reference probe,
    the date probe and the tag lookup all swallow their failures. Several
    variants are searched at once, and one of them stalling must cost that
    variant and nothing more, not the whole turn.
    """
    try:
        return _top_lectures(await search_lectures(ctx, embedding, flt, lang=lang), floor=floor)
    except Exception as exc:  # noqa: BLE001 — a dead lane, not a dead turn
        log.warning(
            "find_tracks_search_failed",
            request_id=ctx.request_id,
            lang=lang,
            error=type(exc).__name__,
        )
        return []


def _merge(runs: list[tuple[str, list[ScoredChunk]]]) -> list[ScoredChunk]:
    """One list out of several near-misses: best chunk per track, best first.

    A track can surface in two of them (the year matched here, the city there);
    it is one lecture and must be offered once.
    """
    best: dict[str, ScoredChunk] = {}
    for _name, lectures in runs:
        for sc in lectures:
            prev = best.get(sc.chunk.track_id)
            if prev is None or sc.score > prev.score:
                best[sc.chunk.track_id] = sc
    return sorted(best.values(), key=lambda sc: sc.score, reverse=True)[:_MAX_LECTURES]


async def search_elsewhere(
    ctx: TurnContext, embedding: list[float], flt: dict, *, floor: float = _MIN_SCORE,
) -> list[ScoredChunk]:
    """The same search, in every corpus language except the one we just tried.

    Not `lang=None`. The lecture embeddings are indexed per language —
    `hnsw_lec_ru`, `hnsw_lec_en` — and a query without the predicate matches no
    index at all: measured on the live corpus, 12 ms with a language against
    1954 ms without one over 559k transcript chunks. Asking each language in
    turn keeps every query on its index and answers the same question.

    Falls back to the unindexed sweep only when the corpus languages cannot be
    read — a slow answer beats none.
    """
    try:
        langs = [
            l for l in await ctx.chunk_repo.distinct_langs()  # type: ignore[union-attr]
            if l and l != ctx.lang_code
        ]
    except Exception as exc:  # noqa: BLE001
        # The corpus languages are also known statically — the deployment
        # configures them (`indexer_langs`, "ru,en"). Using that instead of
        # dropping the predicate keeps even the degraded path on an index:
        # there is no query shape left in this worker that sweeps 559k chunks.
        log.warning(
            "find_tracks_langs_unknown", request_id=ctx.request_id, error=str(exc),
        )
        langs = [
            l for l in fallback_corpus_langs(ctx.settings.corpus_langs) if l != ctx.lang_code
        ]
    if not langs:
        return []
    runs = await asyncio.gather(*(
        try_search(ctx, embedding, flt, lang=l, floor=floor) for l in langs
    ))
    return _merge(list(zip(langs, runs)))


async def find_lectures(
    ctx: TurnContext, embedding: list[float], full: dict, *, topical: bool = True,
) -> Found:
    """Search for what was asked, and — only if that is empty — for the nearest
    thing to it, in one fan-out instead of a walk down a ladder.

    The order of preference is the point:

    1. everything the person said, in their language;
    2. everything they said, in ANOTHER language — "none of these in
       Russian, here they are in English" is a real answer, and it beats
       silently swapping the year and the city: "morning walks in Bombay,
       1976" may exist only in English;
    3. everything but ONE constraint — every such near-miss at once, merged, so
       the reply can say WHICH one has nothing («в Бомбее нет, но за 76 есть»)
       instead of naming a blur of dropped filters;
    4. the cumulative give-up, for when even that is empty.

    Steps 1-3 run their searches concurrently, so the whole thing is bounded by
    the slowest single query rather than the sum of a sequential walk.
    """
    stated = stated_constraints(full)
    if not stated:
        # Nothing to relax — a plain topical search. Keep the cheap two-step:
        # this is the hot path and a speculative second query would double its
        # ANN cost for every ordinary «найди лекции про карму».
        lectures = await try_search(ctx, embedding, full, lang=ctx.lang_code)
        if lectures:
            return Found(lectures)
        lectures = await search_elsewhere(ctx, embedding, full)
        return Found(lectures, other_language=bool(lectures))

    # A request with no TOPIC («покажи утренние прогулки 1976 года в Бомбее»)
    # asks about metadata, and a transcript cannot resemble a description of
    # metadata: the ten Bombay 1976 walks score 0.23 against that sentence in
    # Russian, 0.39 in English, and the 0.45 relevance floor — there to keep
    # junk out of TOPICAL searches — would throw away the very lectures asked for.
    # When the filters are the whole request, they are what selects; the score
    # only orders what they selected.
    exact_floor = _MIN_SCORE if topical else 0.0

    # 1-2. The whole request in the conversation's language; only if that is
    #      empty, the same request in any language.
    #
    #      Sequential on purpose, and it costs nothing: the second lookup is
    #      needed exactly when the first found nothing. Issuing both at once
    #      would make every constrained turn pay for the slowest query shape we
    #      have. Measured against the live index: with a language it is 12 ms
    #      (the per-(kind,lang) partial index), and without one, over the whole
    #      corpus, 1954 ms.
    exact_same = await try_search(ctx, embedding, full, lang=ctx.lang_code, floor=exact_floor)
    if exact_same:
        return Found(exact_same)
    exact_any = await search_elsewhere(ctx, embedding, full, floor=exact_floor)
    if exact_any:
        return Found(exact_any, other_language=True)

    # 3. Each near-miss on its own, both languages, all at once. The teacher is
    #    not offered up here (see `NEVER_ALONE`).
    alone = [n for n in stated if n not in NEVER_ALONE]
    for lang, foreign in ((ctx.lang_code, False), (None, True)):
        if not alone:
            break
        # The near-misses of one language DO go together: they are different
        # questions and their answers are merged into one list. The languages
        # do not — a hit at home ends it, and nothing abroad is searched.
        search = (
            (lambda f: try_search(ctx, embedding, f, lang=lang)) if not foreign
            else (lambda f: search_elsewhere(ctx, embedding, f))
        )
        runs = await asyncio.gather(*(
            search(without(full, [n])) for n in alone
        ))
        hits = [(n, r) for n, r in zip(alone, runs) if r]
        if hits:
            return Found(
                _merge(hits),
                relaxed=",".join(n for n, _ in hits),
                other_language=foreign,
                partial=True,
            )

    # 4. Still nothing: give constraints up cumulatively, narrowest first.
    #    Reached only when no single near-miss had anything either.
    for lang in (ctx.lang_code, None):
        dropped: list[str] = []
        for name in stated:
            dropped.append(name)
            probe = without(full, dropped)
            lectures = (
                await try_search(ctx, embedding, probe, lang=lang) if lang is not None
                else await search_elsewhere(ctx, embedding, probe)
            )
            if lectures:
                return Found(
                    lectures,
                    relaxed=",".join(dropped),
                    other_language=lang is None,
                )
    return Found([])


def _top_lectures(
    chunks: list[ScoredChunk], *, floor: float = _MIN_SCORE,
) -> list[ScoredChunk]:
    """One ScoredChunk per track — the chunk we'll QUOTE — ranked by the
    track's relevance and filtered to the score floor.

    Relevance = the track's best chunk score (intro or not). The quoted chunk
    is the best NON-intro chunk when one exists, else the best chunk.
    """
    by_track: dict[str, list[ScoredChunk]] = defaultdict(list)
    for sc in chunks:
        by_track[sc.chunk.track_id].append(sc)

    picked: list[tuple[float, ScoredChunk]] = []
    for scs in by_track.values():
        relevance = max(s.score for s in scs)
        if relevance < floor:
            continue
        body = [s for s in scs if s.chunk.start_ms >= _INTRO_MS] or scs
        quote = max(body, key=lambda s: s.score)
        picked.append((relevance, quote))

    picked.sort(key=lambda p: p[0], reverse=True)
    return [q for _, q in picked[:_MAX_LECTURES]]
