"""track_pdf_generate — offer printable transcript PDF(s) for a track.

Rendering lives in the standalone `share-transcript` service now; this tool no
longer renders or blocks the turn. It resolves each track's transcript
location + cover metadata from the catalog and emits a single `share_pdf`
action carrying those per track (NO ready URL). The mobile client renders
on demand — it POSTs the metadata + `transcript_key` to share-transcript when the
user taps the share card, then downloads + shares. Same client-initiated
model as audio cuts: the chat turn doesn't wait on PDF generation.

`track_ids` is a list so the tool can offer a small batch in one call.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from typing import Any, Callable

from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.domain.entities import Track
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


YieldEvent = Callable[[str, dict[str, Any]], None]


def _noop_yield(_type: str, _data: dict[str, Any]) -> None:
    """Fallback when this tool is invoked outside the agent loop (tests)."""


# Hard ceiling on a single dispatch — each id is one cheap catalog read
# now (no render), but the share card stays readable at a small count.
MAX_BATCH = 10


def _new_action_id() -> str:
    """Stable, opaque token for the action marker (hex, marker-safe)."""
    return secrets.token_hex(4)


async def _resolve_one(
    track_id: str,
    requested_lang: str,
    catalog_repo: CatalogRepository,
) -> dict[str, Any]:
    """Resolve transcript location + cover metadata for one track.

    Returns the wire dict the client forwards to share-transcript, or
    `{track_id, error}` on a recoverable failure.
    """
    transcript_path, effective_lang = await catalog_repo.resolve_transcript_path(
        track_id, requested_lang=requested_lang,
    )
    if not transcript_path:
        return {"track_id": track_id, "error": "transcript_unavailable"}
    track = await catalog_repo.get_track(track_id, lang=effective_lang)
    if track is None:
        return {"track_id": track_id, "error": "track_not_found"}
    outline_raw, _ = await catalog_repo.get_outline(track_id, effective_lang)
    return _wire(track, effective_lang, transcript_path, _outline_for_wire(outline_raw))


def _outline_for_wire(raw: str | None) -> list[dict[str, Any]]:
    """Parse the catalog outline JSON ([{title,start,end}] ms) into the wire
    list share-transcript renders as the PDF table of contents. [] on
    absent/malformed (the PDF then renders without a TOC)."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(parsed, list):
        return []
    out: list[dict[str, Any]] = []
    for e in parsed:
        if not isinstance(e, dict):
            continue
        title = (e.get("title") or "").strip()
        start = e.get("start")
        if not title or not isinstance(start, (int, float)):
            continue
        item: dict[str, Any] = {"title": title, "start": int(start)}
        end = e.get("end")
        if isinstance(end, (int, float)):
            item["end"] = int(end)
        out.append(item)
    return out


def _wire(
    track: Track, lang: str, transcript_key: str, outline: list[dict[str, Any]],
) -> dict[str, Any]:
    """Per-track share-card row. Carries everything share-transcript needs to
    render (cover metadata + the transcript S3 key + the outline TOC) — no
    pre-rendered URL; the client triggers the render on tap."""
    return {
        "track_id": track.id,
        "lang": lang,
        "title": track.title or track.id,
        "author": track.author_name or track.author_id,
        "date": track.date,
        "location": track.location_name or track.location_id,
        "references": [
            {
                "short_name": r.short_name,
                "full_name": r.full_name,
                "source_id": r.source_id,
                "tokens": r.tokens,
            }
            for r in track.references
        ],
        "tags": list(track.tag_names),
        "transcript_key": transcript_key,
        "outline": outline,
    }


async def generate_track_pdf(
    track_ids: list[str],
    lang: str = "ru",
    *,
    yield_event: YieldEvent = _noop_yield,
    catalog_repo: CatalogRepository,
) -> dict[str, Any]:
    # De-dup + cap upfront, preserving input order so the share card lines
    # up with whatever the user just saw above.
    seen: set[str] = set()
    cleaned: list[str] = []
    for tid in track_ids or []:
        if not isinstance(tid, str) or not tid.strip():
            continue
        tid = tid.strip()
        if tid in seen:
            continue
        seen.add(tid)
        cleaned.append(tid)
        if len(cleaned) >= MAX_BATCH:
            break

    if not cleaned:
        return {"error": "track_ids_required"}

    results = await asyncio.gather(
        *[_resolve_one(tid, lang, catalog_repo) for tid in cleaned]
    )
    ok_items = [r for r in results if "transcript_key" in r]
    errors = [r for r in results if "error" in r]

    if not ok_items:
        return {"error": "no_pdfs_prepared", "details": errors}

    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "share_pdf",
            "id": action_id,
            "payload": {"items": ok_items},
        },
    )
    return {
        "ok": True,
        # Lets the synthesizer's note-renderer recognise this as an action
        # result and emit the `[action:share_pdf|id=...]` marker in prose.
        "kind": "share_pdf",
        "action_id": action_id,
        "items": ok_items,
        "errors": errors,
    }


register_tool(ToolDef(
    name="track_pdf_generate",
    fn=generate_track_pdf,
    emits_events=True,
    description=(
        "Offer downloadable / shareable PDF(s) of full lecture transcripts "
        "(cover + table of contents + time-coded body). Use when the user "
        "asks to «pdf / скачать / поделиться лекцией / share the lecture / "
        "download the transcript» on one or more tracks. Pass the "
        "`track_ids` of every lecture the user wants (cap 10). The PDF is "
        "rendered on demand by the client when the user taps the card — this "
        "tool returns instantly without waiting on generation. After calling, "
        "embed the marker `[action:share_pdf|id=<action_id>]` inline where the "
        "share card should render — DO NOT also emit `[card:...]` for the same "
        "tracks, the share card lists them itself."
    ),
    parameters={
        "type": "object",
        "properties": {
            "track_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Track ids to offer PDFs for. 1 to 10.",
            },
            "lang": {
                "type": "string",
                "enum": ["ru", "en"],
                "description": "Preferred transcript language. Falls back to "
                               "any available language per track.",
            },
        },
        "required": ["track_ids"],
    },
))
