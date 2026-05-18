"""propose_cite / propose_card / propose_outline — validated marker tools.

The chat reply stream historically allowed the LLM to write
`[cite:track@start-end|caption]`, `[card:track]`, `[outline:track]`
markers directly in its prose. The agent forwarded those bytes
verbatim; nothing validated the track_id. Gemini Flash Lite
periodically hallucinated plausible-looking ids (correct prefix,
correct length, never in the catalog) — the client then rendered
broken chips that toast "Не удалось загрузить аудио" on tap.

These tools replace the prose-marker path with a tool-call protocol:

  1. The LLM calls `propose_cite(track_id, start_ms, end_ms, caption)`
     instead of writing the marker.
  2. We validate `track_id` against `CatalogRepository.filter_existing_track_ids`.
  3. On success → yield a `delta` side-event carrying the marker
     string, which the SSE transport streams into the bubble at the
     position the LLM was when it called the tool. Return
     `{ok: True}` so the model knows it can keep writing.
  4. On failure → yield NO event, return
     `{error: "track_not_in_catalog", track_id, hint}` so the model
     gets forced feedback (it cannot proceed by ignoring the result)
     and can either pick a real id or rephrase to omit the citation.

The prompt forbids writing the markers in prose; this is enforced by
protocol (we don't render any marker the tool didn't validate).

Telemetry: every rejection is logged as
`chat_tool_call_rejected{tool=…, reason="track_not_in_catalog"}` so
residual hallucination rate is greppable post-deploy.
"""

from __future__ import annotations

from typing import Any, Callable

from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.observability.logging import get_logger


YieldEvent = Callable[[str, dict[str, Any]], None]


def _noop_yield(_type: str, _data: dict[str, Any]) -> None:
    """Fallback when a tool is invoked outside the agent loop (e.g. tests)."""


log = get_logger(__name__)


_REJECTION_HINT = (
    "track_id is not in the catalog. Use a track_id from your most "
    "recent search_transcripts / list_tracks / get_track result — do "
    "not invent ids or copy them from past chats. If no recent result "
    "matches the point you wanted to cite, omit the marker and "
    "describe the lecture in prose instead."
)


def _log_rejection(tool: str, track_id: str) -> None:
    log.info(
        "chat_tool_call_rejected",
        tool=tool,
        reason="track_not_in_catalog",
        track_id=track_id,
    )


async def propose_cite(
    track_id: str,
    start_ms: int,
    end_ms: int,
    caption: str = "",
    *,
    yield_event: YieldEvent = _noop_yield,
    catalog_repo: CatalogRepository,
) -> dict[str, Any]:
    """Inject a validated `[cite:track@start-end|caption]` marker into
    the reply stream. Caller (LLM) MUST use a track_id returned by a
    recent search/list/get tool — fabricated ids are rejected and the
    error result tells the model to pick again."""
    track_id = (track_id or "").strip()
    if not track_id:
        return {"error": "track_id_required"}
    if end_ms < start_ms:
        end_ms = start_ms
    valid = await catalog_repo.filter_existing_track_ids([track_id])
    if not valid:
        _log_rejection("propose_cite", track_id)
        return {
            "error": "track_not_in_catalog",
            "track_id": track_id,
            "hint": _REJECTION_HINT,
        }
    caption = (caption or "").strip()
    if caption:
        marker = f"[cite:{track_id}@{int(start_ms)}-{int(end_ms)}|{caption}]"
    else:
        marker = f"[cite:{track_id}@{int(start_ms)}-{int(end_ms)}]"
    yield_event("delta", {"text": marker})
    return {"ok": True}


async def propose_card(
    track_id: str,
    *,
    yield_event: YieldEvent = _noop_yield,
    catalog_repo: CatalogRepository,
) -> dict[str, Any]:
    """Inject a validated `[card:track_id]` marker (LectureCard).
    See `propose_cite` docstring for the protocol contract."""
    track_id = (track_id or "").strip()
    if not track_id:
        return {"error": "track_id_required"}
    valid = await catalog_repo.filter_existing_track_ids([track_id])
    if not valid:
        _log_rejection("propose_card", track_id)
        return {
            "error": "track_not_in_catalog",
            "track_id": track_id,
            "hint": _REJECTION_HINT,
        }
    yield_event("delta", {"text": f"[card:{track_id}]"})
    return {"ok": True}


async def propose_outline(
    track_id: str,
    *,
    yield_event: YieldEvent = _noop_yield,
    catalog_repo: CatalogRepository,
) -> dict[str, Any]:
    """Inject a validated `[outline:track_id]` marker (OutlineCard).
    The outline payload itself is emitted by a separate tool
    (`get_track_outline`); this one only validates + injects the
    inline marker so the client knows where to render the card."""
    track_id = (track_id or "").strip()
    if not track_id:
        return {"error": "track_id_required"}
    valid = await catalog_repo.filter_existing_track_ids([track_id])
    if not valid:
        _log_rejection("propose_outline", track_id)
        return {
            "error": "track_not_in_catalog",
            "track_id": track_id,
            "hint": _REJECTION_HINT,
        }
    yield_event("delta", {"text": f"[outline:{track_id}]"})
    return {"ok": True}


register_tool(ToolDef(
    name="propose_cite",
    fn=propose_cite,
    emits_events=True,
    description=(
        "Insert a citation chip into your reply at the current cursor. "
        "You CANNOT write `[cite:...]` markers directly in your reply "
        "text — they will not render. To cite a specific audio span, "
        "call this tool with `track_id` (must come from a recent "
        "search_transcripts / list_tracks / get_track result), the "
        "millisecond range, and a short caption. The agent injects the "
        "validated marker into the reply stream for you. Returns "
        "`{ok: true}` on success, or `{error: 'track_not_in_catalog'}` "
        "if the track_id is fabricated."
    ),
    parameters={
        "type": "object",
        "properties": {
            "track_id": {
                "type": "string",
                "description": (
                    "Catalog id from a recent search_transcripts / "
                    "list_tracks / get_track result. NEVER invent."
                ),
            },
            "start_ms": {"type": "integer"},
            "end_ms": {"type": "integer"},
            "caption": {
                "type": "string",
                "description": "3-6 word label shown on the chip.",
            },
        },
        "required": ["track_id", "start_ms", "end_ms"],
    },
))


register_tool(ToolDef(
    name="propose_card",
    fn=propose_card,
    emits_events=True,
    description=(
        "Insert a lecture-card chip into your reply at the current "
        "cursor. You CANNOT write `[card:...]` markers directly — "
        "they will not render. To surface a lecture as a card, call "
        "this tool with `track_id` from a recent "
        "search_transcripts / list_tracks / get_track result. The "
        "agent injects the validated marker. NEVER invent ids."
    ),
    parameters={
        "type": "object",
        "properties": {
            "track_id": {
                "type": "string",
                "description": (
                    "Catalog id from a recent search_transcripts / "
                    "list_tracks / get_track result."
                ),
            },
        },
        "required": ["track_id"],
    },
))


register_tool(ToolDef(
    name="propose_outline",
    fn=propose_outline,
    emits_events=True,
    description=(
        "Insert an outline-card chip into your reply at the current "
        "cursor. You CANNOT write `[outline:...]` markers directly. "
        "Call `get_track_outline` first to fetch and emit the outline "
        "payload, THEN call this tool with the same `track_id` so the "
        "agent injects the marker that mounts the card. NEVER invent ids."
    ),
    parameters={
        "type": "object",
        "properties": {
            "track_id": {
                "type": "string",
                "description": (
                    "Catalog id from a recent search_transcripts / "
                    "list_tracks / get_track / get_track_outline result."
                ),
            },
        },
        "required": ["track_id"],
    },
))
