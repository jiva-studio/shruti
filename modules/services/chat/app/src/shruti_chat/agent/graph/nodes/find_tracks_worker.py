"""Find-tracks worker — DETERMINISTIC lecture search (intent=find_tracks).

The user asks to FIND lectures about a topic ("найди лекцию про очищение
сердца"). Unlike `research` (which synthesizes an essay), this returns the
LECTURES THEMSELVES as a ranked list of cards, each with a short description
and a verbatim transcript quote showing why it matched.

Everything happens in this node, which terminates at END (no synthesizer):

1. Embed the query and semantic-search transcript chunks, constrained by the
   metadata filters the router extracted (source / year / author / location).
   Group by track, rank lectures by their best chunk score, DROP anything
   below the relevance floor, and quote the best NON-intro chunk (the lecture
   opening is boilerplate, not a reason). Progressive relaxation drops the
   narrowest filter on an empty hit.
2. Resolve each lecture's catalog display (title / author / date / refs) and
   its description — concurrently. A lecture the published catalog doesn't
   carry is dropped (the client couldn't render its card anyway).
3. The ONLY LLM hop: per lecture a short DESCRIPTION blending the lecture's
   own catalog description with the user's question, plus one global intro —
   all run concurrently. The model writes prose only; it never sees a
   track_id or an array, so there is nothing for it to mis-order.
4. Emit straight to the client (bypassing the synthesizer like
   `action_responder`): the global intro, then per lecture a description
   paragraph, a `[card:track]` tile and a `[cite:…]` quote. Each card and
   quote ships a server-resolved `action` payload FIRST (so thin clients with
   no local catalog — web — can render), honouring action-before-marker.
"""

from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.application.author_names import (
    distinctive_tokens,
)
from shruti_chat.agent.graph.nodes._worker_common import (
    LocalizedReply,
    build_cite_payload,
    localized_reply,
    resolve_track_display,
)
from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.prompts import standalone_prompt
from shruti_chat.application.author_lookup import resolve_author
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.config import get_settings
from shruti_chat.domain.entities import Message, ScoredChunk
from shruti_chat.domain.scripture_ref import parse_tokens
from shruti_chat.observability.logging import bind_node_role, get_logger

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


def _year_range(year: object) -> tuple[str | None, str | None]:
    try:
        y = int(year)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None, None
    return f"{y:04d}-01-01", f"{y:04d}-12-31"


async def _resolve_id(ctx: TurnContext, kind: str, text: object) -> str | None:
    """Best-effort name → id for an author / location filter. A miss just
    means we don't constrain on it (the semantic search still runs).

    Resolved across ALL locales (`lang=None`), never `ctx.lang_code`: the router
    normalizes what it extracts to English ("Токио" → "Tokyo"), so matching a
    Latin name against the Cyrillic dictionary scores ~0 and silently drops
    the filter — or worse, picks whatever grazed the cutoff.
    """
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        hits = await ctx.catalog_repo.resolve(kind, text, lang=None, limit=1)  # type: ignore[arg-type]
    except Exception:
        return None
    return hits[0].id if hits else None


# A tag is worth trusting only when the dictionary is fairly sure: below this
# the scorer starts handing back «Речь» for "lecture" and «Прочее» for anything.
_TAG_CONFIDENCE = 0.6


async def _resolve_kind_tag(ctx: TurnContext, kind: object) -> list[str] | None:
    """The catalog tag for the TYPE of recording a request asks for.

    The prompt used to list our ten tag names for the model to choose from —
    a second copy of the catalog, kept by hand, exactly like the book list that
    answered «Шикшаштака» out of the wrong scripture. Now the model writes the
    words the person used and the tag dictionary decides.

    Two passes, because the phrase people actually say does not match the
    dictionary entry: «утренние прогулки» scores 0.56 against «Прогулка» — under
    the bar — while «прогулки» alone scores 0.88, «прогулок» 0.88, «беседах»
    0.92. So the whole phrase first, then its words, longest first.

    A miss narrows nothing, which is the right answer for «лекция»: every
    recording is one, there is no `tag_lecture`, and the nearest match («Речь»,
    0.4) would be a filter nobody asked for.
    """
    if not isinstance(kind, str) or not kind.strip():
        return None
    phrase = kind.replace("_", " ").strip()
    words = sorted(
        (w for w in re.split(r"[^\w-]+", phrase) if len(w) >= 4),
        key=len, reverse=True,
    )
    for text in [phrase, *(w for w in words if w != phrase)]:
        try:
            hits = await ctx.catalog_repo.resolve(  # type: ignore[union-attr]
                "tag", text, lang=None, limit=1,
            )
        except Exception:  # noqa: BLE001 — a tag miss just means we don't constrain
            return None
        if hits and hits[0].confidence >= _TAG_CONFIDENCE:
            return [hits[0].id]
    return None


async def _selected_only(ctx: TurnContext, tracks: list) -> list:
    """Drop tracks the turn's lecturer selection excludes.

    Both catalog probes below are FALLBACKS reached after the semantic ladder —
    which honours the selection — came back empty. Serving them unfiltered is
    how a standing «отвечай только по лекциям X» leaked somebody else's lecture
    in as the answer to a bare reference or date.
    """
    scope = getattr(ctx, "author_scope", None)
    if scope is None or not tracks:
        return tracks
    kept = await scope.narrow([t.id for t in tracks])
    if kept is None:
        return tracks
    allowed = set(kept)
    return [t for t in tracks if t.id in allowed]


async def _resolve_author(ctx: TurnContext, name: str):
    """The corpus author `name` denotes, shared with the `lecture_authors`
    attribute so the two cannot disagree about who is in the corpus."""
    return await resolve_author(ctx.catalog_repo, name)


# Name of the ladder rung that carries a scripture reference. The label ends up
# in the intro prompt as text, so it has to be a string — but the ladder and the
# "was it dropped?" check must never drift apart on a literal.
_REF_RUNG = "reference"


def _was_relaxed(relaxed: str, rung: str) -> bool:
    return rung in relaxed.split(",")


async def _build_filters(
    ctx: TurnContext, args: dict, *, author_id: str | None = None,
) -> list[tuple[str, dict]]:
    """Ordered (relaxed-label, filter-kwargs) ladder: index 0 is fully
    constrained, each next entry drops the narrowest remaining constraint.

    `author_id` is resolved by the CALLER (the same resolution that decided the
    corpus has this teacher at all), so the guard and the filter can never
    disagree about who was asked for.
    """
    source_id = args.get("source_id") if isinstance(args.get("source_id"), str) else None
    # Delivery-date constraint: an explicit ISO range (date_from/date_to) wins;
    # otherwise derive a full-year range from a bare `year`. `anniversary_md`
    # ("MM-DD") narrows to that calendar day across all years. All three combine
    # freely with a topic so "лекции про карму за 1975" / "…9 июля" filter too.
    def _s(k: str) -> str | None:
        v = args.get(k)
        return v if isinstance(v, str) and v else None
    date_from, date_to = _s("date_from"), _s("date_to")
    if not date_from and not date_to:
        date_from, date_to = _year_range(args.get("year"))
    anniversary_md = _s("anniversary_md")
    location_id = await _resolve_id(ctx, "location", args.get("location"))
    tag_ids = await _resolve_kind_tag(ctx, args.get("kind"))
    # A named chapter / canto («лекции по БГ 10») MUST constrain the search.
    # Without it the ANN search returned whatever was semantically closest —
    # chapter 9 lectures for a chapter 10 question — under a lead-in that
    # confidently named chapter 10. `filter_track_ids` applies the same
    # reference predicate as `list_tracks`. Only meaningful together with the
    # source: a bare "10" doesn't say which book.
    ref_prefix = ref_from = ref_to = None
    if source_id:
        parsed = parse_tokens(_s("tokens"))
        if parsed is not None:
            prefix, ref_from, ref_to = parsed
            ref_prefix = ".".join(map(str, prefix)) or None

    full = {
        "author_ids": [author_id] if author_id else None,
        "source_id": source_id,
        "location_id": location_id,
        "tag_ids": tag_ids,
        "date_from": date_from,
        "date_to": date_to,
        "anniversary_md": anniversary_md,
        "ref_prefix": ref_prefix,
        "ref_from": ref_from,
        "ref_to": ref_to,
    }
    return full


# What each named constraint occupies in the filter dict, narrowest first —
# also the order they are given up in when nothing matches the whole set.
# `author` sits late on purpose: a person who named a teacher would rather hear
# that he has nothing from that year than be handed somebody else's lecture.
# `source` last: the book outlives everything else about the request.
_CONSTRAINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (_REF_RUNG, ("ref_prefix", "ref_from", "ref_to")),
    ("date", ("date_from", "date_to", "anniversary_md")),
    ("location", ("location_id",)),
    ("kind", ("tag_ids",)),
    ("author", ("author_ids",)),
    ("source", ("source_id",)),
)

# Giving up the teacher is a different kind of answer — someone else's words —
# so it is never offered as one of the "you asked for four things, three of them
# exist" alternatives. It goes only in the last-resort walk below.
_NEVER_ALONE = frozenset({"author"})


def _stated(full: dict) -> list[str]:
    """The constraints this request actually carries, narrowest first."""
    return [name for name, keys in _CONSTRAINTS if any(full[k] for k in keys)]


def _without(full: dict, names: Iterable[str]) -> dict:
    drop = {k for name, keys in _CONSTRAINTS if name in set(names) for k in keys}
    return {k: (None if k in drop else v) for k, v in full.items()}


async def _search(
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
class _Found:
    """What the search settled on, and what it cost to get there."""

    lectures: list[ScoredChunk]
    relaxed: str = ""          # constraints given up, comma-joined
    other_language: bool = False
    partial: bool = False      # each lecture misses ONE of `relaxed`, not all


async def _try(
    ctx: TurnContext, embedding: list[float], flt: dict, *, lang: str | None,
    floor: float = _MIN_SCORE,
) -> list[ScoredChunk]:
    """One search. A search that fails counts as a search that found nothing.

    Every OTHER lookup in this worker already works that way — the reference
    probe, the date probe, the tag lookup all swallow their failures — but the
    semantic search did not, so a single slow ANN query killed the whole turn
    and the person got an empty bubble. It happened twice in five days
    («Browse by author», «Шикшаштака 1 найди лекции»), and with several
    variants now searched at once, one of them stalling must cost that variant
    and nothing more.
    """
    try:
        return _top_lectures(await _search(ctx, embedding, flt, lang=lang), floor=floor)
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


async def _find_lectures(
    ctx: TurnContext, embedding: list[float], full: dict, *, topical: bool = True,
) -> _Found:
    """Search for what was asked, and — only if that is empty — for the nearest
    thing to it, in one fan-out instead of a walk down a ladder.

    The order of preference is the point:

    1. everything the person said, in their language;
    2. everything they said, in ANOTHER language — «этих на русском нет, вот
       они по-английски» is a real answer, and it beats silently swapping the
       year and the city, which is what walking the ladder in one language did:
       «утренние прогулки 1976 в Бомбее» dropped all three and served two
       unrelated Russian talks while the ten it asked for sat there in English;
    3. everything but ONE constraint — every such near-miss at once, merged, so
       the reply can say WHICH one has nothing («в Бомбее нет, но за 76 есть»)
       instead of naming a blur of dropped filters;
    4. the old cumulative give-up, for when even that is empty.

    Steps 1-3 run their searches concurrently, so the whole thing is bounded by
    the slowest single query rather than the sum of a sequential walk.
    """
    stated = _stated(full)
    if not stated:
        # Nothing to relax — a plain topical search. Keep the cheap two-step:
        # this is the hot path and a speculative second query would double its
        # ANN cost for every ordinary «найди лекции про карму».
        lectures = await _try(ctx, embedding, full, lang=ctx.lang_code)
        if lectures:
            return _Found(lectures)
        lectures = await _try(ctx, embedding, full, lang=None)
        return _Found(lectures, other_language=bool(lectures))

    # A request with no TOPIC («покажи утренние прогулки 1976 года в Бомбее»)
    # asks about metadata, and a transcript cannot resemble a description of
    # metadata: the ten Bombay 1976 walks score 0.23 against that sentence in
    # Russian, 0.39 in English, and the 0.45 relevance floor — there to keep
    # junk out of TOPICAL searches — threw away the very lectures asked for.
    # When the filters are the whole request, they are what selects; the score
    # only orders what they selected.
    exact_floor = _MIN_SCORE if topical else 0.0

    # 1-2. The whole request in the conversation's language; only if that is
    #      empty, the same request in any language.
    #
    #      Sequential on purpose, and it costs nothing: the second lookup is
    #      needed exactly when the first found nothing. Issuing both at once —
    #      as this did — meant every constrained turn paid for the slowest
    #      query shape we have. Measured on production against the live index:
    #      with a language it is 12 ms (the per-(kind,lang) partial index), and
    #      without one, over the whole corpus, 1954 ms. Two ANN timeouts in
    #      five days followed that change; this removes the query nobody was
    #      waiting for.
    exact_same = await _try(ctx, embedding, full, lang=ctx.lang_code, floor=exact_floor)
    if exact_same:
        return _Found(exact_same)
    exact_any = await _try(ctx, embedding, full, lang=None, floor=exact_floor)
    if exact_any:
        return _Found(exact_any, other_language=True)

    # 3. Each near-miss on its own, both languages, all at once. The teacher is
    #    not offered up here (see `_NEVER_ALONE`).
    alone = [n for n in stated if n not in _NEVER_ALONE]
    for lang, foreign in ((ctx.lang_code, False), (None, True)):
        if not alone:
            break
        # The near-misses of one language DO go together: they are different
        # questions and their answers are merged into one list. The languages
        # do not — a hit at home ends it, and the slow lane is never opened.
        runs = await asyncio.gather(*(
            _try(ctx, embedding, _without(full, [n]), lang=lang) for n in alone
        ))
        hits = [(n, r) for n, r in zip(alone, runs) if r]
        if hits:
            return _Found(
                _merge(hits),
                relaxed=",".join(n for n, _ in hits),
                other_language=foreign,
                partial=True,
            )

    # 4. Still nothing: give constraints up cumulatively, narrowest first, as
    #    before. Reached only when no single near-miss had anything either.
    for lang in (ctx.lang_code, None):
        dropped: list[str] = []
        for name in stated:
            dropped.append(name)
            lectures = await _try(ctx, embedding, _without(full, dropped), lang=lang)
            if lectures:
                return _Found(
                    lectures,
                    relaxed=",".join(dropped),
                    other_language=lang is None,
                )
    return _Found([])


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


async def _language_names(ctx: TurnContext, codes: list[str]) -> str:
    """Native names for locale codes ("en" → "English"), comma-joined. The
    `languages` table is the source of truth; an unknown code degrades to the
    code itself so the line still names SOMETHING concrete."""
    names: list[str] = []
    for code in codes:
        name = None
        if ctx.catalog_repo is not None:
            try:
                name = await ctx.catalog_repo.language_name(code)
            except Exception:  # noqa: BLE001 — a label miss must not fail the turn
                name = None
        names.append(name or code)
    return ", ".join(names)


async def _other_language_note(
    ctx: TurnContext, found_langs: list[str],
) -> str:
    """The situation clause for lectures that exist only in ANOTHER language.

    Names BOTH sides — the language the user asked in and the one the lectures
    are actually in — because "available in another language" leaves the user
    guessing which. Empty when nothing was found outside their language.
    """
    others = [c for c in dict.fromkeys(found_langs) if c and c != ctx.lang_code]
    if not others:
        return ""
    requested = await _language_names(ctx, [ctx.lang_code])
    available = await _language_names(ctx, others)
    return (
        f" IMPORTANT: there is NO transcript in the user's own language "
        f"({requested}); these lectures are in {available}. Say BOTH parts "
        f"explicitly — that nothing was found in {requested}, but these were "
        f"found in {available} — naming each language naturally in the user's "
        f"language (e.g. «на русском нет, но нашлись на английском»)."
    )


async def _describe(ctx: TurnContext, query: str, title: str, description: str, excerpt: str) -> str:
    """A short, grounded description of ONE lecture, tilted toward the user's
    question. Built from the lecture's own catalog description — NOT a verdict
    on whether it matches (that produced "this lecture is NOT about X")."""
    sys = standalone_prompt("find-tracks-description", "find_tracks_description")
    usr = (
        f"User question: {query}\n"
        f"Lecture title: {title or '—'}\n"
        f"Lecture description: {description or '—'}\n"
        f"Relevant excerpt: {excerpt[:300]}\n\n"
        f"Write the description in language code '{ctx.lang_code}'."
    )
    msgs: list[Message] = [{"role": "system", "content": sys}, {"role": "user", "content": usr}]
    try:
        out = await ctx.llm.text_completion(
            msgs, model=get_settings().llm_cheap, run_name="find_tracks_description"
        )
    except Exception:  # noqa: BLE001 — a flaky cheap-model call on ONE card's blurb
        # must not blow up the whole find_track turn (it's gathered with the
        # others). Degrade to no description; the card still renders from its title.
        log.warning("find_tracks_description_failed", request_id=ctx.request_id)
        return ""
    return out.strip()


async def _intro(
    ctx: TurnContext, query: str, n: int, relaxed: str, *,
    lang_note: str = "", ref: str = "", chosen_authors: str = "",
    partial: bool = False, unknown_source: str = "", dropped_source: str = "",
) -> str:
    sys = standalone_prompt("find-tracks-intro", "find_tracks_intro")
    facts = [
        f"User query: {query}",
        f"Lectures found: {n}",
        f"Relaxed filters: {relaxed or 'none'}",
    ]
    if dropped_source:
        # The book exists, the lectures about it do not. «найди лекции по
        # письмам Прабхупады» came back as «вот лекции по письмам Прабхупады,
        # но не из всех источников» over lectures that have nothing to do with
        # the letters — the filter had been given up and the line still spoke
        # as if it held.
        facts.append(
            f"IMPORTANT: the library has NO lectures on {dropped_source}. The "
            f"list below was found by the words of the request instead. Say "
            f"that there is nothing on {dropped_source} and do NOT describe "
            f"these lectures as being on it."
        )
    if unknown_source:
        # The person named a book the catalog does not have. Searching the rest
        # of the corpus for it is fine; pretending we looked inside that book is
        # not — «Шикшаштака 1 найди лекции» was answered out of a different
        # scripture entirely, and nothing in the reply said so.
        facts.append(
            f"IMPORTANT: the user named «{unknown_source}», and there is no such "
            f"book in the library. Say that plainly first — the library does not "
            f"have «{unknown_source}» — and then that these are lectures found by "
            f"the words of the request. Never imply the list came from that book."
        )
    if partial:
        # These lectures are near-misses of DIFFERENT constraints, not a list
        # that gave all of them up: one matches the year but not the city, the
        # next the other way round. Saying "relaxed: date, location" would read
        # as "I ignored both", which is what the old single-list answer sounded
        # like — «с немного изменённой датой и местом» above two unrelated talks.
        facts.append(
            f"IMPORTANT: nothing matches the request exactly. Each lecture below "
            f"matches everything EXCEPT ONE of: {relaxed}. Say plainly that "
            f"there is no exact match and which of these did not exist, e.g. "
            f"«за 1976 в Бомбее ничего нет — вот прогулки 1976 года и вот "
            f"бомбейские других лет». Do NOT claim the list matches the request."
        )
    if lang_note:
        facts.append(lang_note)
    if ref:
        # The defect this exists for: the line said «Вот лекции по Бхагавад-гите
        # 10:» above lectures on chapter 9, and the user had to point it out
        # («Ты мне раньше дал 9 главу вместо 12»). A confidently wrong header is
        # worse than an honest miss, so when the reference filter had to be
        # dropped the line is FORBIDDEN to claim it.
        facts.append(
            f"IMPORTANT: the user asked for {ref}, and the corpus has NO lecture "
            f"on it. These lectures are NOT on {ref}. Say plainly that there is "
            f"nothing on {ref} and that these are other lectures on the same "
            f"book. Do NOT write {ref} as if the list matched it."
        )
    if chosen_authors:
        # Same honesty as the reference case above, and only for an EMPTY list:
        # "nothing found" under a lecturer filter must name the filter, or it
        # reads as "the corpus has nothing on this" and the person never learns
        # their own choice is the reason. A non-empty list needs no such line —
        # every card in it is already by them.
        facts.append(
            f"IMPORTANT: the user limited the answer to lectures by "
            f"{chosen_authors}, and the corpus has nothing by them for this "
            f"request. Say that plainly, naming {chosen_authors}."
        )
    usr = "\n".join(facts) + f"\n\nWrite the line in language code '{ctx.lang_code}'."
    msgs: list[Message] = [{"role": "system", "content": sys}, {"role": "user", "content": usr}]
    try:
        out = await ctx.llm.text_completion(
            msgs, model=get_settings().llm_cheap, run_name="find_tracks_intro"
        )
    except Exception:  # noqa: BLE001 — same resilience as _describe: a flaky call on
        # the lead-in must not kill the turn. Degrade to no intro line.
        log.warning("find_tracks_intro_failed", request_id=ctx.request_id)
        return ""
    return out.strip()


async def find_tracks_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("find_tracks_worker")
    ctx = runtime.context
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "searching_corpus"}})

    query = (state.get("user_query") or "").strip()
    args = state.get("extracted_args") or {}

    if ctx.embedder is None or ctx.chunk_repo is None or ctx.catalog_repo is None or not query:
        log.warning("find_tracks_missing_deps", request_id=ctx.request_id)
        return await _emit_empty(ctx, writer, query)

    # The user named a teacher. Resolve them ONCE — the same resolution decides
    # whether the corpus has them at all AND which author_id constrains the
    # search, so the guard and the filter cannot disagree. A name that is only
    # honorifics ("Свами") denotes nobody in particular: no guard, no filter.
    author_id: str | None = None
    requested_author = args.get("author")
    if isinstance(requested_author, str) and distinctive_tokens(requested_author):
        hit = await _resolve_author(ctx, requested_author)
        if hit is None:
            # The corpus does NOT have this teacher. Guard here so the unresolved
            # author can't drop out of the filter and let the semantic search
            # return SOME OTHER teacher's lectures (which synth would then
            # misattribute). Route to add-to-library web discovery instead.
            if not ctx.capabilities.get("personal_library"):
                return await _emit_empty(ctx, writer, query)
            log.info(
                "find_tracks_unknown_author_web_fallback",
                request_id=ctx.request_id,
                author=requested_author.strip()[:60],
            )
            return {"web_fallback": True}
        author_id = hit.id

    embedding = await ctx.embedder.embed_query(query)
    full = await _build_filters(ctx, args, author_id=author_id)

    # The router extracts `topic` when the request is ABOUT something; a bare
    # metadata request («утренние прогулки 1976 Бомбей») carries none.
    topical = bool(str(args.get("topic") or "").strip())
    # A book the catalog never heard of: no filter was built from it (the router
    # set it aside), so the only thing left to do is admit it.
    unknown_source = str(args.get("unknown_source") or "").strip()
    found = await _find_lectures(ctx, embedding, full, topical=topical)
    lectures, relaxed = found.lectures, found.relaxed
    lang_note = ""
    if lectures and found.other_language:
        # The lecture exists, just not with a transcript in the language of the
        # conversation. Hiding it reads as "the corpus doesn't have it" (a ru
        # user asking for a Tokyo 1972 talk that only has an en transcript was
        # told exactly that), so we serve it and SAY which language it is in.
        lang_note = await _other_language_note(
            ctx, [sc.chunk.lang for sc in lectures],
        )
        log.info(
            "find_tracks_other_language",
            request_id=ctx.request_id,
            requested_lang=ctx.lang_code,
            found_langs=sorted({sc.chunk.lang for sc in lectures}),
        )

    if not lectures:
        # Semantic search found nothing — but for a BARE scripture reference
        # that's the wrong tool: "sb 1.2.6-1.2.18" embeds to noise, so a real
        # match scores below the floor. The catalog maps lectures→verses
        # directly (track_references), so probe that index deterministically
        # before giving up. Most bare refs DO have lectures the embedding
        # missed — serve them. Only when the ref-index is ALSO empty do we ask
        # whether the user wanted the verses themselves.
        source_id = args.get("source_id")
        tokens = args.get("tokens")
        if source_id and tokens:
            return await _probe_and_answer_ref(
                ctx, writer, str(source_id), str(tokens), author_id=author_id,
            )
        # A date-only query ("лекции, прочитанные 9 июля") is also invisible to
        # semantic search (no topic to embed). The catalog stores a per-track
        # date, so probe it directly by year range and/or "on this day" (MM-DD
        # across all years — the anniversary the user usually means).
        date_from = args.get("date_from")
        date_to = args.get("date_to")
        anniversary = args.get("anniversary_md")
        if date_from or date_to or anniversary:
            return await _probe_and_answer_date(
                ctx, writer, date_from, date_to, anniversary, author_id=author_id,
            )
        # No lecture in the corpus (not a bare scripture ref / date probe):
        # route to add-to-library web discovery, read by route_after_find_tracks.
        if not ctx.capabilities.get("personal_library"):
            return await _emit_empty(ctx, writer, query, unknown_source=unknown_source)
        log.info("find_tracks_empty_web_fallback", request_id=ctx.request_id, query=query[:80])
        return {"web_fallback": True}

    track_ids = [sc.chunk.track_id for sc in lectures]
    # Server-resolved display (title/author/date/refs) for thin clients, and
    # the per-track description — concurrently. A track the published catalog
    # doesn't carry has no display title → drop it (client can't render it).
    displays, outlines = await asyncio.gather(
        asyncio.gather(*(resolve_track_display(ctx, tid) for tid in track_ids)),
        asyncio.gather(*(ctx.catalog_repo.get_outline(tid, ctx.lang_code) for tid in track_ids)),
    )
    kept = [
        (sc, disp, (outline[1] or ""))
        for sc, disp, outline in zip(lectures, displays, outlines)
        if disp.get("track_title")
    ]
    if not kept:
        log.info("find_tracks_all_uncatalogued", request_id=ctx.request_id)
        return await _emit_empty(ctx, writer, query)

    # The only LLM hop — per-lecture descriptions + the global intro, all
    # concurrent. Each call sees ONE lecture; wall-clock ≈ one call.
    desc_tasks = [
        _describe(ctx, query, disp.get("track_title", ""), description, sc.chunk.text)
        for sc, disp, description in kept
    ]
    # When the reference filter had to be dropped, the lead-in gets the human
    # address it must NOT claim («БГ 10»). Costs a catalog lookup only on that
    # miss path.
    dropped_source = ""
    if _was_relaxed(relaxed, "source") and args.get("source_id"):
        _, short = await _resolve_source(ctx, str(args.get("source_id")))
        dropped_source = short or ""
    ref_label = ""
    if _was_relaxed(relaxed, _REF_RUNG):
        _, short = await _resolve_source(ctx, str(args.get("source_id") or ""))
        tokens = str(args.get("tokens") or "").strip()
        ref_label = f"{short} {tokens}".strip() if short else tokens
    intro_task = _intro(
        ctx, query, len(kept), relaxed, lang_note=lang_note, ref=ref_label,
        partial=found.partial, unknown_source=unknown_source,
        dropped_source=dropped_source,
    )
    prose = await asyncio.gather(intro_task, *desc_tasks)
    intro, descriptions = prose[0], list(prose[1:])

    writer({"type": "status", "data": {"key": "composing_answer"}})
    if intro:
        writer({"type": "delta", "data": {"text": intro + "\n\n"}})

    for (sc, disp, _description), desc_text in zip(kept, descriptions):
        chunk = sc.chunk
        tid = chunk.track_id
        if desc_text:
            writer({"type": "delta", "data": {"text": desc_text + "\n\n"}})

        # Card attribution payload — so a catalog-less client (web) can render
        # the lecture tile. Emitted BEFORE the [card:] marker.
        writer({
            "type": "action",
            "data": {"kind": "card", "id": tid, "payload": {"track_id": tid, **disp}},
        })

        ref = ctx.aliases.alias_chunk(tid, chunk.start_ms, chunk.end_ms, lang=chunk.lang)
        ctx.aliases.chunk_texts[ref] = chunk.text
        cite = await build_cite_payload(ctx, ref, ctx.aliases.resolve(ref))
        if cite is not None:
            writer({
                "type": "action",
                "data": {
                    "kind": "cite_transcript",
                    "id": f"cite_{tid}_{chunk.start_ms}_{chunk.end_ms}",
                    "payload": cite,
                },
            })

        marker = f"[card:{tid}]\n"
        if cite is not None:
            marker += f"[cite:{tid}@{chunk.start_ms}-{chunk.end_ms}]\n"
        writer({"type": "delta", "data": {"text": marker + "\n"}})

    log.info(
        "find_tracks_ok",
        request_id=ctx.request_id,
        n_lectures=len(kept),
        relaxed=relaxed,
    )
    return {}


def _emit_reply(writer, reply, *, prefix_line: str = "", suffix: str = "") -> None:
    """Stream a LocalizedReply: the line (optionally with a trailing `suffix`
    like the card block already emitted separately) then its follow-up chips,
    each as a `[followup:…]` marker on its own line."""
    line = (reply.line or "").strip()
    if line:
        writer({"type": "delta", "data": {"text": prefix_line + line + suffix}})
    for chip in reply.chips[:3]:
        # `]` / newline would break the marker; `|` is the valid label|query
        # separator, so it stays.
        chip = chip.replace("]", "").replace("\n", "").strip()
        if chip:
            writer({"type": "delta", "data": {"text": f"\n[followup:{chip}]"}})


async def _resolve_source(ctx: TurnContext, source_id: str) -> tuple[str, str | None]:
    """Resolve a source arg to `(opaque_id, short_label)`. `source_id` may be an
    opaque catalog id (deterministic path) OR an abbreviation like "SB" (the LLM
    router emits the abbrev). Returns the opaque id needed for the ref lookup and
    the label localized to `ctx.lang_code` ("ШБ" for ru). Falls back to the input id
    and a None label when the repo can't resolve it."""
    if ctx.catalog_repo is None:
        return source_id, None
    try:
        short = await ctx.catalog_repo.source_short_label(source_id, lang=ctx.lang_code)
    except Exception:  # noqa: BLE001 — a label miss must never fail the turn
        short = None
    if short:  # source_id was already the opaque id
        return source_id, short
    try:
        hits = await ctx.catalog_repo.resolve("source", source_id, lang=None, limit=1)
    except Exception:  # noqa: BLE001
        hits = []
    # The resolved id DRIVES the lecture filter (source_id=opaque below), not
    # just the label — so a weak fuzzy match must not swap in the wrong book.
    # Require real confidence; below it, keep the input id (which won't match →
    # the honest "no lectures, show verses?" clarify) rather than serve a
    # different scripture.
    if not hits or hits[0].confidence < 0.6:
        return source_id, None
    opaque = hits[0].id
    try:
        short = await ctx.catalog_repo.source_short_label(opaque, lang=ctx.lang_code)
    except Exception:  # noqa: BLE001
        short = None
    return opaque, (short or hits[0].extra.get("short_name") or None)


async def _probe_and_answer_ref(
    ctx: TurnContext, writer, source_id: str, tokens: str,
    *, author_id: str | None = None,
) -> dict:
    """Semantic search missed a bare scripture ref. Probe the catalog's
    lecture→verse index (deterministic, no embedding) and either SERVE the
    lectures it finds, or — when that index is also empty — ask whether the user
    wanted the verses themselves.

    The teacher carries into the probe. This lane used to pass `author_id=None`
    and skip the turn's selection, so «лекции Прабхупады по ШБ 2.9.1» — and any
    standing «только по лекциям X» — served whoever the ref index happened to
    hold. A fallback is still an answer; it does not get to forget who was
    asked for."""
    opaque, short = await _resolve_source(ctx, source_id)
    ref = f"{short} {tokens}" if short else tokens

    tracks = []
    lang_note = ""
    parsed = parse_tokens(tokens)
    if parsed is not None and ctx.catalog_repo is not None:
        prefix, ref_from, ref_to = parsed

        async def _probe(lang: str | None):
            return await ctx.catalog_repo.list_tracks(
                author_id=author_id, source_id=opaque, location_id=None, tag_ids=None,
                title_query=None, date_from=None, date_to=None, lang=lang,
                limit=8, offset=0,
                ref_prefix=".".join(map(str, prefix)) or None,
                ref_from=ref_from, ref_to=ref_to,
            )

        try:
            tracks = await _probe(ctx.lang_code)
            if not tracks:
                # This ref has no lecture transcribed in the user's language.
                # It may well exist in another — the prod case was a ru user
                # asking for ШБ 2.9.1 (Tokyo, 1972), which the corpus HAS in
                # English only, and being told "лекций Шрилы Прабхупады нет".
                tracks = await _probe(None)
                if tracks:
                    lang_note = await _other_language_note(
                        ctx, [t.lang for t in tracks],
                    )
        except Exception:  # noqa: BLE001 — a probe miss falls back to the clarify
            log.exception("find_tracks_ref_probe_failed", request_id=ctx.request_id)
            tracks = []

    tracks = await _selected_only(ctx, tracks)
    writer({"type": "status", "data": {"key": "composing_answer"}})
    cards = await _renderable(ctx, tracks)

    if cards:
        # SERVE: these are the lectures semantic search missed. Emit a lead-in
        # (LLM-localized to the user's language), one card per lecture, and a
        # chip to see the verses instead. The count is of RENDERABLE cards
        # (title-less ones dropped), so it never claims more than it shows.
        log.info(
            "find_tracks_ref_served", request_id=ctx.request_id,
            source_id=opaque, tokens=tokens, n=len(cards),
        )
        reply = await localized_reply(
            ctx,
            f"Found {len(cards)} lecture(s) that discuss the verses {ref}. Write a "
            f"one-line lead-in for the list below. Add ONE chip that means 'show "
            f"the verses {ref} themselves' and includes '{ref}'.{lang_note}",
        )
        _emit_reply(writer, LocalizedReply(line=reply.line or "", chips=[]), suffix="\n\n")
        _stream_cards(writer, cards)
        for chip in (reply.chips or [])[:1]:
            chip = chip.replace("]", "").replace("|", "").strip()
            if chip:
                writer({"type": "delta", "data": {"text": f"[followup:{chip}]"}})
        return {}

    # The ref-index is empty too — ask whether they wanted the verses.
    log.info(
        "find_tracks_ref_clarify", request_id=ctx.request_id,
        source_id=opaque, tokens=tokens,
    )
    reply = await localized_reply(
        ctx,
        f"No lectures were found on {ref}. Ask, in one short line, whether the "
        f"user wants to read the verses {ref} themselves. Add ONE chip meaning "
        f"'show verses {ref}' that includes '{ref}'.",
    )
    _emit_reply(writer, reply)
    return {}


async def _probe_and_answer_date(
    ctx: TurnContext, writer, date_from, date_to, anniversary_md,
    *, author_id: str | None = None,
) -> dict:
    """A date-only query has no topic to embed, so probe the catalog's per-track
    date index directly: `date_from`/`date_to` bound a year/range, `anniversary_md`
    ("MM-DD") matches that calendar day across ALL years ("in this day in
    history"). Serve what's found, else say so honestly.

    Narrowed by the named teacher and by the turn's selection, same as the ref
    probe above — «что читали 9 июля» under «только Прабхупада» must not answer
    with somebody else's talk."""
    tracks = []
    lang_note = ""
    if ctx.catalog_repo is not None:

        async def _probe(lang: str | None):
            return await ctx.catalog_repo.list_tracks(
                author_id=author_id, source_id=None, location_id=None, tag_ids=None,
                title_query=None, date_from=date_from, date_to=date_to, lang=lang,
                limit=8, offset=0, anniversary_md=anniversary_md,
            )

        try:
            tracks = await _probe(ctx.lang_code)
            if not tracks:
                # Nothing transcribed in the user's language for this date —
                # show what exists in another rather than claiming the date is
                # empty (same reasoning as the ref probe).
                tracks = await _probe(None)
                if tracks:
                    lang_note = await _other_language_note(
                        ctx, [t.lang for t in tracks],
                    )
        except Exception:  # noqa: BLE001 — a probe miss falls back to the empty line
            log.exception("find_tracks_date_probe_failed", request_id=ctx.request_id)
            tracks = []
    tracks = await _selected_only(ctx, tracks)
    # A plain-English description of the requested date so the localized lead-in
    # states the RIGHT date (never invents one — the LLM has no date otherwise).
    if anniversary_md and "-" in anniversary_md:
        mm, dd = anniversary_md.split("-", 1)
        date_desc = (
            f"the recurring calendar day — month {int(mm)}, day {int(dd)} "
            f"(i.e. day {int(dd)} of month {int(mm)}) — across ALL years, an "
            f"anniversary (NOT one specific year)"
        )
    elif date_from and date_to:
        date_desc = f"the date range {date_from} to {date_to} (ISO YYYY-MM-DD)"
    elif date_from:
        date_desc = f"on or after {date_from} (ISO YYYY-MM-DD)"
    else:
        date_desc = f"on or before {date_to} (ISO YYYY-MM-DD)"

    writer({"type": "status", "data": {"key": "composing_answer"}})
    cards = await _renderable(ctx, tracks)
    if cards:
        log.info(
            "find_tracks_date_served", request_id=ctx.request_id,
            date_from=date_from, date_to=date_to, anniversary_md=anniversary_md,
            n=len(cards),
        )
        reply = await localized_reply(
            ctx,
            f"Found {len(cards)} lecture(s) delivered on {date_desc}. Write a "
            f"one-line lead-in that names this date NATURALLY in the user's "
            f"language (e.g. 'лекции за 9 июля'). Use ONLY this date — do not "
            f"invent a specific year or a different date. No chips.{lang_note}",
        )
        _emit_reply(writer, LocalizedReply(line=reply.line or "", chips=[]), suffix="\n\n")
        _stream_cards(writer, cards)
        return {}
    reply = await localized_reply(
        ctx, f"No lectures were found for {date_desc}. Say so in one short line, "
             f"naming the date naturally in the user's language. No invented "
             f"dates. No chips.",
    )
    _emit_reply(writer, reply)
    return {}


async def _renderable(ctx: TurnContext, tracks) -> list[tuple[str, dict]]:
    """Resolve display attribution for each track, DROPPING any with no title —
    a catalog-less client can't render it (same invariant as the main find
    path). Returns [(track_id, payload), …] so the caller can size the lead-in
    to what will actually show and fall through when nothing is renderable."""
    out: list[tuple[str, dict]] = []
    for track in tracks:
        disp = await resolve_track_display(ctx, track.id)
        title = disp.get("track_title") or track.title
        if not title:
            continue
        out.append((track.id, {"track_id": track.id, **disp, "track_title": title}))
    return out


def _stream_cards(writer, cards: list[tuple[str, dict]]) -> None:
    """Emit one card action + `[card:id]` marker per resolved card
    (payload-before-marker, honouring the SSE ordering invariant)."""
    for track_id, payload in cards:
        writer({"type": "action",
                "data": {"kind": "card", "id": track_id, "payload": payload}})
        writer({"type": "delta", "data": {"text": f"[card:{track_id}]\n\n"}})


async def _emit_empty(
    ctx: TurnContext, writer, query: str, *, unknown_source: str = "",
) -> dict:
    """No lectures found — one localized line, nothing else."""
    writer({"type": "status", "data": {"key": "composing_answer"}})
    line = ""
    scope = getattr(ctx, "author_scope", None)
    chosen = (
        scope.selection.names
        if scope is not None and scope.selection.constrained
        else ""
    )
    if ctx.llm is not None and query:
        try:
            line = await _intro(
                ctx, query, 0, "", chosen_authors=chosen,
                unknown_source=unknown_source,
            )
        except Exception:
            log.exception("find_tracks_empty_intro_failed", request_id=ctx.request_id)
    if line:
        writer({"type": "delta", "data": {"text": line}})
    return {}


