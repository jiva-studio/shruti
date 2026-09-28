"""Find-tracks filters: what the request constrains, resolved to catalog ids,
and the order those constraints are given up in when nothing matches.
"""

from __future__ import annotations

import re
from typing import Iterable

from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.domain.author_lookup import resolve_author
from shruti_chat.domain.scripture_ref import parse_tokens


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

    The model writes the words the person used and the tag dictionary decides,
    so the prompt carries no hand-kept copy of the catalog's tag names.

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


async def resolve_named_author(ctx: TurnContext, name: str):
    """The corpus author `name` denotes, shared with the `lecture_authors`
    attribute so the two cannot disagree about who is in the corpus."""
    return await resolve_author(ctx.catalog_repo, name)


# Name of the ladder rung that carries a scripture reference. The label ends up
# in the intro prompt as text, so it has to be a string — but the ladder and the
# "was it dropped?" check must never drift apart on a literal.
REF_RUNG = "reference"


def was_relaxed(relaxed: str, rung: str) -> bool:
    return rung in relaxed.split(",")


async def build_filters(
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
    # Without it the ANN search returns whatever is semantically closest —
    # chapter 9 lectures for a chapter 10 question. `filter_track_ids` applies the same
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
    (REF_RUNG, ("ref_prefix", "ref_from", "ref_to")),
    ("date", ("date_from", "date_to", "anniversary_md")),
    ("location", ("location_id",)),
    ("kind", ("tag_ids",)),
    ("author", ("author_ids",)),
    ("source", ("source_id",)),
)

# Giving up the teacher is a different kind of answer — someone else's words —
# so it is never offered as one of the "you asked for four things, three of them
# exist" alternatives. It goes only in the last-resort walk below.
NEVER_ALONE = frozenset({"author"})


def stated_constraints(full: dict) -> list[str]:
    """The constraints this request actually carries, narrowest first."""
    return [name for name, keys in _CONSTRAINTS if any(full[k] for k in keys)]


def without(full: dict, names: Iterable[str]) -> dict:
    drop = {k for name, keys in _CONSTRAINTS if name in set(names) for k in keys}
    return {k: (None if k in drop else v) for k, v in full.items()}


async def resolve_source(ctx: TurnContext, source_id: str) -> tuple[str, str | None]:
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
