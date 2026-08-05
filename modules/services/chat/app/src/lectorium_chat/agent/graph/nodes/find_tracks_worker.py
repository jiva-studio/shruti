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
from collections import defaultdict

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.application.author_names import (
    distinctive_tokens,
)
from lectorium_chat.agent.graph.nodes._worker_common import (
    LocalizedReply,
    build_cite_payload,
    localized_reply,
    resolve_track_display,
)
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.prompts import standalone_prompt
from lectorium_chat.application.author_lookup import resolve_author
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.config import get_settings
from lectorium_chat.domain.entities import Message, ScoredChunk
from lectorium_chat.domain.scripture_ref import parse_tokens
from lectorium_chat.observability.logging import bind_node_role, get_logger

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


async def _resolve_kind_tag(ctx: TurnContext, kind: object) -> list[str] | None:
    """The catalog tag for a recording TYPE («утренние прогулки» → morning_walk).

    The router has always extracted `kind`, and nothing ever read it: the filter
    slot said `tag_ids: None`, so «утренние прогулки 1976 Бомбей» narrowed by
    year and city and served ordinary lectures from them.

    Catalog tag ids are `tag_<kind>` exactly, so the resolved hit is accepted
    only when it IS that id. That checks the tag exists AND makes a fuzzy near-
    miss impossible — "lecture", which has no tag of its own (everything is one),
    must narrow nothing rather than land on «Речь».
    """
    if not isinstance(kind, str) or not kind.strip():
        return None
    wanted = f"tag_{kind.strip().lower()}"
    try:
        hits = await ctx.catalog_repo.resolve(  # type: ignore[union-attr]
            "tag", kind.replace("_", " "), lang=None, limit=5,
        )
    except Exception:  # noqa: BLE001 — a tag miss just means we don't constrain
        return None
    return [wanted] if any(h.id == wanted for h in hits) else None


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
    ladder: list[tuple[str, dict]] = [("", dict(full))]
    relaxed: list[str] = []
    for label, keys in (
        # Narrowest first: the reference is the constraint most likely to leave
        # nothing, and dropping it degrades to "lectures on this book" — which
        # `_intro` then has to admit to.
        (_REF_RUNG, ("ref_prefix", "ref_from", "ref_to")),
        ("date", ("date_from", "date_to", "anniversary_md")),
        ("location", ("location_id",)),
        # The TYPE of recording outlives the city: someone who asked for morning
        # walks would rather see one from another year than a lecture from the
        # right one. Dropped only when the pair above already failed.
        ("kind", ("tag_ids",)),
        ("author", ("author_ids",)),
        ("source", ("source_id",)),
    ):
        if not any(full[k] for k in keys):
            continue
        for k in keys:
            full[k] = None
        relaxed.append(label)
        ladder.append((",".join(relaxed), dict(full)))
    return ladder


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


async def _run_ladder(
    ctx: TurnContext, embedding: list[float], ladder: list[tuple[str, dict]],
    *, lang: str | None,
) -> tuple[list[ScoredChunk], str]:
    """Walk the relaxation ladder until a rung yields lectures. Returns the
    lectures and the label of the constraints that had to be dropped."""
    for label, flt in ladder:
        lectures = _top_lectures(await _search(ctx, embedding, flt, lang=lang))
        if lectures:
            return lectures, label
    return [], ""


def _top_lectures(chunks: list[ScoredChunk]) -> list[ScoredChunk]:
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
        if relevance < _MIN_SCORE:
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
) -> str:
    sys = standalone_prompt("find-tracks-intro", "find_tracks_intro")
    facts = [
        f"User query: {query}",
        f"Lectures found: {n}",
        f"Relaxed filters: {relaxed or 'none'}",
    ]
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
    ladder = await _build_filters(ctx, args, author_id=author_id)

    # The teacher the user NAMED outranks the language. Giving the author up
    # answers with somebody else's lecture and says nothing about it; crossing
    # the language boundary keeps the person and can say which language they
    # speak in. So the same-language pass stops before the author rung, and only
    # the any-language pass below is allowed to drop the author. A query with no
    # author has no such rung and walks the whole ladder either way.
    keeps_author = [rung for rung in ladder if "author" not in rung[0].split(",")]
    lectures, relaxed = await _run_ladder(ctx, embedding, keeps_author, lang=ctx.lang_code)
    lang_note = ""
    if not lectures:
        # Nothing with a transcript in the user's language — but the lecture may
        # exist in ANOTHER one, and hiding it reads as "the corpus doesn't have
        # it" (a ru user asking for a Tokyo 1972 talk that only has an en
        # transcript was told exactly that). Retry language-agnostically and,
        # when that finds something, SAY which language it's in.
        lectures, relaxed = await _run_ladder(ctx, embedding, ladder, lang=None)
        if lectures:
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
            return await _emit_empty(ctx, writer, query)
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
    ref_label = ""
    if _was_relaxed(relaxed, _REF_RUNG):
        _, short = await _resolve_source(ctx, str(args.get("source_id") or ""))
        tokens = str(args.get("tokens") or "").strip()
        ref_label = f"{short} {tokens}".strip() if short else tokens
    intro_task = _intro(
        ctx, query, len(kept), relaxed, lang_note=lang_note, ref=ref_label,
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


async def _emit_empty(ctx: TurnContext, writer, query: str) -> dict:
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
            line = await _intro(ctx, query, 0, "", chosen_authors=chosen)
        except Exception:
            log.exception("find_tracks_empty_intro_failed", request_id=ctx.request_id)
    if line:
        writer({"type": "delta", "data": {"text": line}})
    return {}


