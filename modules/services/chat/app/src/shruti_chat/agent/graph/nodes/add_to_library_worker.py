"""Add-to-library worker — DETERMINISTIC (intent=add-to-library).

A PRO-only capability: the user points at an external lecture — a YouTube
link, or a description we search for across providers — and chat surfaces it
as a tappable candidate CARD. Chat is DISCOVERY ONLY: it NEVER ingests. The
user taps "Add to library" (+) on a card and the mobile client submits the URL
to the orchestrator ingest API (`POST /orchestrator/ingest`), which fetches +
transcribes + indexes it (#1224). This worker publishes nothing to the broker.

Flow (no synthesizer — terminates at END like find_tracks_worker):

1. PRO gate. `tier != "pro"` (free / anon) → emit an `upgrade_to_pro`
   upsell card + a localized line, and stop. No search (saves the external-API
   cost for users who can't use the result anyway).
2. Concrete lecture URL? If the message points AT a specific lecture — a
   YouTube watch/short link or a direct http(s) audio file — the user pasted an
   exact target. Skip the search and offer that URL as a SINGLE candidate card
   (with a resolved title/thumbnail).
3. Otherwise it's a search query. Resolve candidates (a bare non-lecture URL
   is taken verbatim; a description goes through the multi-provider resolver:
   YouTube API → yt-dlp → SerpApi → DataForSEO), keeping only ingestable URLs.
4. Nothing found → localized "couldn't find it" line, stop.
5. Emit each candidate as a card — a server-resolved `action` payload FIRST
   (kind=`library_candidate`), then its `[card:…]` marker (action-before-
   marker, same invariant as find_tracks_worker). The tap → the client's
   ingest-API submit; the worker's job ends at the card.
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


def _is_ingestable_url(url: str) -> bool:
    """Whether an ingest worker can actually fetch this URL — currently a
    YouTube link or a direct audio file (mirrors the ingest service's extractor
    registry). Search candidates that fail this are dropped before display so we
    never offer the user something we can't add. THIS is the extension point for
    new sources: when a downloader for another site is added to ingest, add its
    URL shape to `_concrete_lecture_url` and its candidates start flowing here
    automatically."""
    return _concrete_lecture_url(url) is not None


async def _youtube_oembed(url: str) -> tuple[str, str, str]:
    """Best-effort (title, author, thumbnail) for a YouTube URL via the keyless
    oEmbed endpoint. Returns ("", "", "") for a non-YouTube url or any failure —
    the caller falls back to the ingest worker's filename-derived title."""
    if not _YT_ID_RE.search(url or ""):
        return "", "", ""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(
                "https://www.youtube.com/oembed",
                params={"url": url, "format": "json"},
            )
        if resp.status_code != 200:
            return "", "", ""
        data = resp.json()
    except Exception:  # noqa: BLE001 — metadata is best-effort, never fail the add
        return "", "", ""
    return (
        str(data.get("title") or ""),
        str(data.get("author_name") or ""),
        str(data.get("thumbnail_url") or ""),
    )


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

    # ── 2. Concrete lecture URL → a single candidate card ───────────────
    # The user pointed AT a specific lecture (pasted a link). Chat NEVER ingests
    # — it only surfaces a card; the user taps "Add to library" (+) and the
    # client submits to the ingest API. So skip the search but still offer the
    # URL as one card (with a resolved title/thumbnail), reusing the card path.
    concrete_url = _concrete_lecture_url(query)
    if concrete_url:
        title, author, thumbnail = await _youtube_oembed(concrete_url)
        candidates = [
            Candidate(
                url=concrete_url,
                title=title or concrete_url,
                author=author or "",
                thumbnail=thumbnail or _youtube_thumb(concrete_url),
                provider="user_link",
            )
        ]
    else:
        # ── 3. Resolve candidates (search query) ────────────────────────
        # Search the CLEAN terms the router extracted, not the raw command (a
        # keyword search for a whole "find X on the web and add it" sentence
        # returns nothing). COMBINE author + topic so a lecturer search stays
        # anchored to the PERSON: "Niranjana Swami karma", not a bare topic
        # "karma" that returns pop songs. Fall back to the full query when the
        # router surfaced neither.
        args = state.get("extracted_args") or {}
        author = (args.get("author") or "").strip()
        topic = (args.get("topic") or "").strip()
        search_term = " ".join(p for p in (author, topic) if p) or query
        candidates = await _resolve_candidates(ctx, search_term)
        # Only offer what an ingest worker can actually fetch — drop any candidate
        # whose URL no downloader handles, so the user never taps "Add" on
        # something we can't process.
        candidates = [c for c in candidates if _is_ingestable_url(c.url)]
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
    # The worker only surfaces tappable candidate cards — it never ingests. The
    # tap is handled entirely on the client: it submits the card's URL to the
    # orchestrator ingest API. This avoids adding a lecture the user never chose.
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
