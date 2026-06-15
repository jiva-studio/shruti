"""track_outline_get — serve a precomputed lecture outline from the catalog.

The outline (chapter headings) and description are generated offline by
shruti-mcp and published in the catalog DB (track_variants.outline /
.description). This tool only READS them and emits the `outline` action for
the client — it never calls an LLM. Lecture-outline generation lives in the
mcp, not here.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


YieldEvent = Callable[[str, dict[str, Any]], None]


def _noop_yield(_type: str, _data: dict[str, Any]) -> None:
    """Fallback when this tool is invoked outside the agent loop (tests)."""


def _items_from_outline(raw: str | None) -> list[dict[str, Any]]:
    """Parse the stored outline JSON ([{title,start,end}] ms) into the client
    action shape ([{start_ms, title}]). Returns [] on any malformed/absent
    value — the caller treats an empty list as "no outline"."""
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        log.warning("outline_parse_failed")
        return []
    if not isinstance(parsed, list):
        return []
    items: list[dict[str, Any]] = []
    for entry in parsed:
        if not isinstance(entry, dict):
            continue
        title = (entry.get("title") or "").strip()
        start = entry.get("start")
        if not title or not isinstance(start, (int, float)):
            continue
        items.append({"start_ms": int(start), "title": title})
    return items


async def get_track_outline(
    track_id: str,
    lang: str = "ru",
    *,
    yield_event: YieldEvent = _noop_yield,
    catalog_repo: CatalogRepository,
) -> dict[str, Any]:
    """Return the precomputed outline items + emit the `outline` action.

    `lang` is the user's preferred outline language; we read the variant for
    the effective transcript language (the requested one may not exist for
    this track — same fallback as the transcript)."""
    _, effective_lang = await catalog_repo.resolve_transcript_path(
        track_id, requested_lang=lang,
    )
    outline_raw, _description = await catalog_repo.get_outline(track_id, effective_lang)
    items = _items_from_outline(outline_raw)
    if not items:
        return {
            "error": "outline_unavailable",
            "track_id": track_id,
            "lang": effective_lang,
        }
    yield_event(
        "action",
        {
            "kind": "outline",
            "id": f"outline_{track_id}",
            "payload": {"track_id": track_id, "items": items},
        },
    )
    return {
        "track_id": track_id,
        "lang": effective_lang,
        "items": items,
    }


register_tool(ToolDef(
    name="track_outline_get",
    fn=get_track_outline,
    emits_events=True,
    description=(
        "Fetch the precomputed outline for a track: a few coarse chapter-like "
        "items with timecodes (start_ms) and titles. Use when the user asks "
        "for a summary, the contents of a lecture, or 'recap what I just "
        "listened to'. After calling, embed the marker '[outline:<track_id>]' "
        "in your reply where the outline card should render — the client "
        "mounts an interactive list at that position."
    ),
    parameters={
        "type": "object",
        "properties": {
            "track_id": {"type": "string"},
            "lang": {"type": "string", "enum": ["ru", "en"]},
        },
        "required": ["track_id"],
    },
))
