"""Add-to-library worker — DETERMINISTIC (intent=add-to-library).

A PRO-only capability: the user points at an external lecture — a YouTube
link, or a description we search for across providers — and we add it to
their personal library by publishing an `ingest.request` for the ingest
worker (#1224) to fetch + transcribe + index.

Flow (no synthesizer — terminates at END like find_tracks_worker):

1. PRO gate. `tier != "pro"` (free / anon) → emit an `upgrade_to_pro`
   upsell card + a localized line, and stop. No search, no publish (saves
   the external-API cost for users who can't use the result anyway).
2. Concrete lecture URL? If the message points AT a specific lecture — a
   YouTube watch/short link or a direct http(s) audio file — the user has
   already chosen it (pasted a link, or tapped "Add to library" on a
   candidate card, which the mobile app re-sends as a chat turn). Skip the
   search and publish `ingest.request` for that URL DIRECTLY (via the
   `add_to_library_publish` action-tool → XADD {user_id, url, jwt}), then
   confirm "added, processing". No candidate cards.
3. Otherwise it's a search query. Resolve candidates (a bare non-lecture URL
   is taken verbatim; a description goes through the multi-provider resolver:
   YouTube API → yt-dlp → SerpApi → DataForSEO).
4. Nothing found → localized "couldn't find it" line, stop.
5. Emit each candidate as a card — a server-resolved `action` payload FIRST
   (kind=`library_candidate`), then its `[card:…]` marker (action-before-
   marker, same invariant as find_tracks_worker).

For a SEARCH query the worker does not publish `ingest.request` itself:
publishing happens when the user taps a candidate card's "Add to library"
action, which re-sends the concrete URL as a new chat turn (step 2) or invokes
the `add_to_library_publish` action-tool. Only a concrete lecture URL — an
explicit, user-chosen target — publishes directly. Every publish is best-effort
and the broker no-ops when `STREAMS_REDIS_URL` is unset.
"""

from __future__ import annotations

import re
from typing import Any

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from shruti_chat.agent.graph.nodes._worker_common import localized_reply
from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.agent.tools.actions import _new_action_id
from shruti_chat.agent.tools.add_to_library import add_to_library_publish
from shruti_chat.infra.broker.publisher import NoopIngestPublisher
from shruti_chat.lecture_search.models import Candidate
from shruti_chat.observability.logging import bind_node_role, get_logger

log = get_logger(__name__)

# At most five options — the user scans a short list and adds one.
_MAX_CANDIDATES = 5

# Grab the first http(s) URL in the message. A pasted link is an exact
# target, so we skip the search entirely and add it directly.
_URL_RE = re.compile(r"https?://[^\s<>\]\)]+", re.IGNORECASE)

# A CONCRETE lecture URL the user points AT (vs. a description to search for):
# a YouTube watch / shorts / live / youtu.be link, or a direct http(s) audio
# file. When one is present we publish `ingest.request` for it directly rather
# than surfacing search cards — the user (or the app's "Add to library" tap,
# which re-sends the URL as a chat turn) has already chosen the exact target.
_YOUTUBE_URL_RE = re.compile(
    r"https?://(?:www\.|m\.|music\.)?"
    r"(?:youtube\.com/(?:watch\?[^\s<>\]\)]*\bv=[\w-]+|shorts/[\w-]+|live/[\w-]+)"
    r"|youtu\.be/[\w-]+)"
    r"[^\s<>\]\)]*",
    re.IGNORECASE,
)
_AUDIO_URL_RE = re.compile(
    r"https?://[^\s<>\]\)]+\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac)"
    r"(?:\?[^\s<>\]\)]*)?",
    re.IGNORECASE,
)

# YouTube video id (the canonical 11-char token) out of any watch / shorts /
# live / youtu.be url, so we can build the free cover image from it.
_YT_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?[^\s<>\]\)]*\bv=|shorts/|live/)|youtu\.be/)"
    r"([\w-]{11})",
    re.IGNORECASE,
)


def _youtube_thumb(url: str) -> str:
    """Best-effort YouTube cover URL derived from the video id — free, no API
    call. Returns "" for non-YouTube urls (or an unrecognizable id)."""
    m = _YT_ID_RE.search(url or "")
    return f"https://i.ytimg.com/vi/{m.group(1)}/hqdefault.jpg" if m else ""


def _concrete_lecture_url(text: str) -> str | None:
    """Return the first concrete lecture URL (a YouTube watch/short link or a
    direct audio file) in `text`, or None when it's a plain search query."""
    for rx in (_YOUTUBE_URL_RE, _AUDIO_URL_RE):
        m = rx.search(text or "")
        if m:
            return m.group(0).rstrip(".,)")
    return None


async def add_to_library_worker_node(
    state: ChatState, runtime: Runtime[TurnContext]
) -> dict:
    bind_node_role("add_to_library_worker")
    ctx = runtime.context
    writer = get_stream_writer()
    writer({"type": "status", "data": {"key": "preparing_action"}})

    def _yield_event(event_type: str, data: dict[str, Any]) -> None:
        if event_type == "action":
            aid = data.get("id")
            if isinstance(aid, str) and aid:
                ctx.emitted_action_ids.add(aid)
        writer({"type": event_type, "data": data})

    tier = (state.get("tier") or "free").strip().lower()
    query = (state.get("user_query") or "").strip()

    # ── 1. PRO gate ────────────────────────────────────────────────────
    if tier != "pro":
        return await _emit_upsell(ctx, writer, _yield_event)

    # ── 2. Concrete lecture URL → publish ingest.request directly ───────
    # The user pointed AT a specific lecture (pasted a link, or tapped
    # "Add to library" on a candidate card — the mobile app re-sends the URL
    # as a chat turn). Skip search and publish for it; no candidate cards.
    concrete_url = _concrete_lecture_url(query)
    if concrete_url:
        return await _publish_direct(ctx, writer, _yield_event, concrete_url)

    # ── 3. Resolve candidates (search query) ────────────────────────────
    # Search the CLEAN term the router extracted, not the raw command: a keyword
    # search for a whole "find X on the web and add it" sentence returns nothing,
    # while the bare topic returns the lectures. A "find lectures of <teacher>"
    # turn extracts the name as `author` rather than `topic`, so try that too.
    # Fall back to the full query only when the router surfaced neither.
    args = state.get("extracted_args") or {}
    search_term = (
        (args.get("topic") or "").strip()
        or (args.get("author") or "").strip()
        or query
    )
    candidates = await _resolve_candidates(ctx, search_term)
    if not candidates:
        reply = await localized_reply(
            ctx,
            "The user wants to add an external lecture to their library but no "
            "matching video was found. Say so in one short line and suggest they "
            "paste a direct link. No chips.",
        )
        writer({"type": "status", "data": {"key": "composing_answer"}})
        _emit_line(writer, reply.line)
        log.info("add_to_library_no_candidates", request_id=ctx.request_id)
        return {}

    writer({"type": "status", "data": {"key": "composing_answer"}})

    # ── 5. Offer the candidates ────────────────────────────────────────
    # We do NOT publish here. The worker only surfaces tappable candidate
    # cards; the actual `ingest.request` is published solely when the user
    # taps a card's "Add to library" action (the `add_to_library_publish`
    # action-tool). This avoids adding a lecture the user never chose.
    top = candidates[0]
    lead = await localized_reply(
        ctx,
        f"Tell the user we found «{top.title or top.url}»"
        + (" and other options" if len(candidates) > 1 else "")
        + " and invite them to tap a result to add it to their personal "
        "library. One short line. No chips.",
    )
    _emit_line(writer, lead.line)

    # ── 4. Candidate cards (the top one plus alternatives) ─────────────
    _stream_candidate_cards(writer, candidates[:_MAX_CANDIDATES])

    log.info(
        "add_to_library_ok",
        request_id=ctx.request_id,
        n_candidates=len(candidates),
        top_provider=top.provider,
    )
    return {}


async def _resolve_candidates(ctx: TurnContext, query: str) -> list[Candidate]:
    """A pasted URL wins verbatim; otherwise search the provider resolver."""
    m = _URL_RE.search(query)
    if m:
        url = m.group(0).rstrip(".,)")
        # The rest of the message (minus the URL) is a decent title hint.
        title = _URL_RE.sub("", query).strip() or url
        return [
            Candidate(
                url=url,
                title=title,
                thumbnail=_youtube_thumb(url),
                provider="user_link",
            )
        ]

    resolver = getattr(ctx, "lecture_search", None)
    if resolver is None:
        log.warning("add_to_library_no_resolver", request_id=ctx.request_id)
        return []
    try:
        return await resolver.search(query, limit=_MAX_CANDIDATES)
    except Exception:  # noqa: BLE001 — a resolver blow-up degrades to "not found"
        log.exception("add_to_library_search_failed", request_id=ctx.request_id)
        return []


async def _publish_direct(ctx: TurnContext, writer, yield_event, url: str) -> dict:
    """Concrete lecture URL: publish exactly one `ingest.request` for `url`
    and confirm — no search, no candidate cards.

    Delegates to the `add_to_library_publish` action-tool (the same one the
    card tap uses): it publishes once, then emits the `added_to_library`
    confirmation action. The publish is best-effort — a down/absent broker
    (or an unset `STREAMS_REDIS_URL`, → NoopIngestPublisher) still confirms
    so the client shows the pending state instead of failing the turn.
    """
    publisher = getattr(ctx, "ingest_publisher", None) or NoopIngestPublisher()
    # Publish silently: no `yield_event`, so no action event is emitted (the
    # client has no "done" card and would render an orphan marker as raw text).
    # The text line below plus the My Library shelf are the user's feedback.
    result = await add_to_library_publish(
        url=url,
        user_id=ctx.user_id or "",
        jwt=ctx.jwt or "",
        publisher=publisher,
    )
    reply = await localized_reply(
        ctx,
        f"Tell the user their lecture «{url}» was added to their personal "
        "library and is now being processed (transcribed and indexed). One "
        "short, friendly line. No chips.",
    )
    writer({"type": "status", "data": {"key": "composing_answer"}})
    _emit_line(writer, reply.line)
    # No action marker here: a concrete URL is already published, and the client
    # has no card for a "done" state. The text line above tells the user it's
    # processing; the My Library shelf shows the item and its processing→ready
    # status. (Emitting `[action:added_to_library|…]` here surfaced as raw marker
    # text on clients that only render the `add_to_library` candidate card.)
    log.info(
        "add_to_library_publish_direct",
        request_id=ctx.request_id,
        url=url,
        published=result.get("published"),
    )
    return {}


async def _emit_upsell(ctx: TurnContext, writer, yield_event) -> dict:
    """Free / anon: surface the Pro paywall and explain why this is Pro."""
    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "upgrade_to_pro",
            "id": action_id,
            "payload": {"reason": "add_to_library"},
        },
    )
    reply = await localized_reply(
        ctx,
        "Adding external lectures to your personal library is a Pro feature. "
        "Tell the user in one short, friendly line that this needs Pro. No chips.",
    )
    writer({"type": "status", "data": {"key": "composing_answer"}})
    _emit_line(writer, reply.line)
    writer({
        "type": "delta",
        "data": {"text": f"\n[action:upgrade_to_pro|id={action_id}]\n"},
    })
    log.info("add_to_library_upsell", request_id=ctx.request_id, tier="free")
    return {}


def _stream_candidate_cards(writer, candidates: list[Candidate]) -> None:
    """One `add_to_library` action + `[action:add_to_library|id=<id>]` marker per
    candidate, payload emitted BEFORE its marker (SSE ordering invariant).

    The kind (`add_to_library`) and the `[action:…]` marker match the shared
    `ChatActionPayload` contract the mobile app renders (ActionCardAddToLibrary):
    tapping "Add" re-sends `url` as a chat turn, which reaches the concrete-URL
    branch above and publishes. An earlier revision emitted `library_candidate`
    + a `[card:…]` marker that no client knew, so the card showed as raw text."""
    for i, c in enumerate(candidates):
        cid = f"cand_{i}"
        writer({
            "type": "action",
            "data": {
                "kind": "add_to_library",
                "id": cid,
                "payload": {
                    "url": c.url,
                    "title": c.title,
                    "author": c.author,
                    "duration": c.duration,
                    # Fall back to the free YouTube cover when the provider gave
                    # none, so the card always has art for a YouTube lecture.
                    "thumbnail": c.thumbnail or _youtube_thumb(c.url),
                    "lang_hint": c.lang_hint,
                    "provider": c.provider,
                },
            },
        })
        writer({
            "type": "delta",
            "data": {"text": f"[action:add_to_library|id={cid}]\n\n"},
        })


def _emit_line(writer, line: str) -> None:
    line = (line or "").strip()
    if line:
        writer({"type": "delta", "data": {"text": line + "\n\n"}})
