"""Add-to-library worker — DETERMINISTIC (intent=add-to-library).

A PRO-only capability: the user points at an external lecture — a YouTube
link, or a description we search for across providers — and we add it to
their personal library by publishing an `ingest.request` for the ingest
worker (#1224) to fetch + transcribe + index.

Flow (no synthesizer — terminates at END like find_tracks_worker):

1. PRO gate. `tier != "pro"` (free / anon) → emit an `upgrade_to_pro`
   upsell card + a localized line, and stop. No search, no publish (saves
   the external-API cost for users who can't use the result anyway).
2. Resolve candidates. A direct URL in the message is taken verbatim (one
   candidate); otherwise the multi-provider resolver searches
   (YouTube API → yt-dlp → SerpApi → DataForSEO).
3. Nothing found → localized "couldn't find it" line, stop.
4. Emit each candidate as a card — a server-resolved `action` payload FIRST
   (kind=`library_candidate`), then its `[card:…]` marker (action-before-
   marker, same invariant as find_tracks_worker).

The worker NEVER publishes `ingest.request` itself. Publishing happens only
when the user taps a candidate card's "Add to library" action, which invokes
the `add_to_library_publish` action-tool (→ XADD `ingest.request`
{user_id, url, jwt}). This keeps ingest an explicit, user-chosen action
rather than a speculative side effect of every Pro turn.
"""

from __future__ import annotations

import re
from typing import Any

from langgraph.config import get_stream_writer
from langgraph.runtime import Runtime

from lectorium_chat.agent.graph.nodes._worker_common import localized_reply
from lectorium_chat.agent.graph.state import ChatState
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.agent.tools.actions import _new_action_id
from lectorium_chat.lecture_search.models import Candidate
from lectorium_chat.observability.logging import bind_node_role, get_logger

log = get_logger(__name__)

# At most five options — the user scans a short list and adds one.
_MAX_CANDIDATES = 5

# Grab the first http(s) URL in the message. A pasted link is an exact
# target, so we skip the search entirely and add it directly.
_URL_RE = re.compile(r"https?://[^\s<>\]\)]+", re.IGNORECASE)


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

    # ── 2. Resolve candidates ──────────────────────────────────────────
    candidates = await _resolve_candidates(ctx, query)
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
        return [Candidate(url=url, title=title, provider="user_link")]

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
    """One `library_candidate` action + `[card:<id>]` marker per candidate,
    payload emitted BEFORE its marker (SSE ordering invariant)."""
    for i, c in enumerate(candidates):
        cid = f"cand_{i}"
        writer({
            "type": "action",
            "data": {
                "kind": "library_candidate",
                "id": cid,
                "payload": {
                    "url": c.url,
                    "title": c.title,
                    "author": c.author,
                    "duration": c.duration,
                    "thumbnail": c.thumbnail,
                    "lang_hint": c.lang_hint,
                    "provider": c.provider,
                },
            },
        })
        writer({"type": "delta", "data": {"text": f"[card:{cid}]\n\n"}})


def _emit_line(writer, line: str) -> None:
    line = (line or "").strip()
    if line:
        writer({"type": "delta", "data": {"text": line + "\n\n"}})
