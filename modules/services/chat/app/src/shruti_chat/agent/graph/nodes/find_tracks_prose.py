"""Find-tracks prose: the per-lecture descriptions, the lead-in line and the
localized replies, each one cheap-model call that degrades to nothing.
"""

from __future__ import annotations

from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.agent.prompts import standalone_prompt
from shruti_chat.domain.entities import Message
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


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


async def other_language_note(
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


async def describe_lecture(ctx: TurnContext, query: str, title: str, description: str, excerpt: str) -> str:
    """A short, grounded description of ONE lecture, tilted toward the user's
    question. Built from the lecture's own catalog description — NOT a verdict
    on whether it matches (a verdict reads as "this lecture is NOT about X")."""
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
            msgs, model=ctx.settings.llm_cheap, run_name="find_tracks_description"
        )
    except Exception:  # noqa: BLE001 — a flaky cheap-model call on ONE card's blurb
        # must not blow up the whole find_track turn (it's gathered with the
        # others). Degrade to no description; the card still renders from its title.
        log.warning("find_tracks_description_failed", request_id=ctx.request_id)
        return ""
    return out.strip()


async def write_intro(
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
        # The book exists, the lectures about it do not. The source filter was
        # given up, so the line must not speak as if it held ("here are
        # lectures on Prabhupada's letters" over lectures unrelated to them).
        facts.append(
            f"IMPORTANT: the library has NO lectures on {dropped_source}. The "
            f"list below was found by the words of the request instead. Say "
            f"that there is nothing on {dropped_source} and do NOT describe "
            f"these lectures as being on it."
        )
    if unknown_source:
        # The person named a book the catalog does not have. Searching the rest
        # of the corpus for it is fine; pretending we looked inside that book is
        # not: the reply must say the book is missing rather than answer out
        # of a different scripture as if it were that book.
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
        # as "I ignored both" — «с немного изменённой датой и местом».
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
        # A header like «Вот лекции по Бхагавад-гите 10:» above lectures on
        # chapter 9 is worse than an honest miss, so when the reference filter
        # had to be dropped the line must not claim it.
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
            msgs, model=ctx.settings.llm_cheap, run_name="find_tracks_intro"
        )
    except Exception:  # noqa: BLE001 — same resilience as describe_lecture: a flaky call on
        # the lead-in must not kill the turn. Degrade to no intro line.
        log.warning("find_tracks_intro_failed", request_id=ctx.request_id)
        return ""
    return out.strip()


def emit_reply(writer, reply, *, prefix_line: str = "", suffix: str = "") -> None:
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


async def emit_empty(
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
            line = await write_intro(
                ctx, query, 0, "", chosen_authors=chosen,
                unknown_source=unknown_source,
            )
        except Exception:
            log.exception("find_tracks_empty_intro_failed", request_id=ctx.request_id)
    if line:
        writer({"type": "delta", "data": {"text": line}})
    return {}
