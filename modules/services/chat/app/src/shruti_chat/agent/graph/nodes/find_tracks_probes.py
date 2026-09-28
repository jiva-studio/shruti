"""Find-tracks catalog probes: the deterministic reference and date lookups
reached when semantic search has nothing for a bare reference or date.
"""

from __future__ import annotations

from shruti_chat.agent.graph.nodes._worker_common import LocalizedReply, localized_reply
from shruti_chat.agent.graph.nodes.find_tracks_cards import renderable_cards, stream_cards
from shruti_chat.agent.graph.nodes.find_tracks_filters import resolve_source
from shruti_chat.agent.graph.nodes.find_tracks_prose import emit_reply, other_language_note
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.domain.scripture_ref import parse_tokens
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


async def _selected_only(ctx: TurnContext, tracks: list) -> list:
    """Drop tracks the turn's lecturer selection excludes.

    Both catalog probes below are FALLBACKS reached after the semantic ladder —
    which honours the selection — came back empty. Served unfiltered, a standing
    «отвечай только по лекциям X» would let somebody else's lecture in as the
    answer to a bare reference or date.
    """
    scope = getattr(ctx, "author_scope", None)
    if scope is None or not tracks:
        return tracks
    kept = await scope.narrow([t.id for t in tracks])
    if kept is None:
        return tracks
    allowed = set(kept)
    return [t for t in tracks if t.id in allowed]


async def probe_and_answer_ref(
    ctx: TurnContext, writer, source_id: str, tokens: str,
    *, author_id: str | None = None,
) -> dict:
    """Semantic search missed a bare scripture ref. Probe the catalog's
    lecture→verse index (deterministic, no embedding) and either SERVE the
    lectures it finds, or — when that index is also empty — ask whether the user
    wanted the verses themselves.

    The teacher and the turn's selection carry into the probe, so "Prabhupada's
    lectures on SB 2.9.1" — and any standing "only from X's lectures" — never
    serves whoever the ref index happens to hold. A fallback is still an
    answer; it does not get to forget who was asked for."""
    opaque, short = await resolve_source(ctx, source_id)
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
                # It may well exist in another — ШБ 2.9.1 (Tokyo, 1972) exists
                # in English only — so show that rather than "no lectures".
                tracks = await _probe(None)
                if tracks:
                    lang_note = await other_language_note(
                        ctx, [t.lang for t in tracks],
                    )
        except Exception:  # noqa: BLE001 — a probe miss falls back to the clarify
            log.exception("find_tracks_ref_probe_failed", request_id=ctx.request_id)
            tracks = []

    tracks = await _selected_only(ctx, tracks)
    writer({"type": "status", "data": {"key": "composing_answer"}})
    cards = await renderable_cards(ctx, tracks)

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
        emit_reply(writer, LocalizedReply(line=reply.line or "", chips=[]), suffix="\n\n")
        stream_cards(writer, cards)
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
    emit_reply(writer, reply)
    return {}


async def probe_and_answer_date(
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
                    lang_note = await other_language_note(
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
    cards = await renderable_cards(ctx, tracks)
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
        emit_reply(writer, LocalizedReply(line=reply.line or "", chips=[]), suffix="\n\n")
        stream_cards(writer, cards)
        return {}
    reply = await localized_reply(
        ctx, f"No lectures were found for {date_desc}. Say so in one short line, "
             f"naming the date naturally in the user's language. No invented "
             f"dates. No chips.",
    )
    emit_reply(writer, reply)
    return {}
