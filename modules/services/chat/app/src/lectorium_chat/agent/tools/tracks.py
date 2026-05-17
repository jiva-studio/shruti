"""get_track — full metadata for one track id.

Thin LLM-tool wrapper: delegates to `CatalogRepository.get_track` and
reshapes the domain `Track` into the wire format the agent expects.
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.agent.tools._registry import ToolDef, register_tool
from lectorium_chat.domain.entities import Track
from lectorium_chat.domain.ports.catalog_repository import CatalogRepository


def _to_wire(track: Track) -> dict[str, Any]:
    return {
        "track_id": track.id,
        "title": track.title,
        "date": track.date,
        "author": (
            {"id": track.author_id, "name": track.author_name or track.author_id}
            if track.author_id else None
        ),
        "location": (
            {"id": track.location_id, "name": track.location_name or track.location_id}
            if track.location_id else None
        ),
        "tag_ids": list(track.tag_ids),
        "tag_names": list(track.tag_names),
        "duration_ms": track.duration_ms,
        "languages": list(track.languages),
        "references": [
            {
                "source_id": r.source_id,
                "full_name": r.full_name,
                "short_name": r.short_name,
                "tokens": r.tokens,
            }
            for r in track.references
        ],
    }


async def get_track(
    track_id: str,
    lang: str = "ru",
    *,
    catalog_repo: CatalogRepository,
) -> dict[str, Any] | None:
    track = await catalog_repo.get_track(track_id, lang=lang)
    return _to_wire(track) if track else None


register_tool(ToolDef(
    name="get_track",
    fn=get_track,
    description="Fetch full metadata for one track by id. Use to enrich a citation.",
    parameters={
        "type": "object",
        "properties": {
            "track_id": {"type": "string"},
            "lang": {"type": "string", "default": "ru"},
        },
        "required": ["track_id"],
    },
))
