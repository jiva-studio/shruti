"""resolve_{author,source,location,tag} — fuzzy dictionary lookup.

Thin LLM-tool wrappers over `CatalogRepository.resolve`. Each wrapper
re-keys the result so the wire payload matches what the agent expects
(author_id / source_id / location_id / tag_id) and drops kind-specific
extras (e.g. sources include `short_name`).
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.domain.ports.catalog_repository import CatalogRepository


async def resolve_author(
    text: str, lang: str | None = None,
    *, catalog_repo: CatalogRepository,
) -> list[dict[str, Any]]:
    out = await catalog_repo.resolve("author", text, lang=lang, limit=8)
    return [
        {"author_id": r.id, "full_name": r.full_name, "confidence": r.confidence}
        for r in out
    ]


async def resolve_source(
    text: str, lang: str | None = None,
    *, catalog_repo: CatalogRepository,
) -> list[dict[str, Any]]:
    out = await catalog_repo.resolve("source", text, lang=lang, limit=8)
    return [
        {
            "source_id": r.id,
            "full_name": r.full_name,
            "confidence": r.confidence,
            "short_name": r.extra.get("short_name"),
        }
        for r in out
    ]


async def resolve_location(
    text: str, lang: str | None = None,
    *, catalog_repo: CatalogRepository,
) -> list[dict[str, Any]]:
    out = await catalog_repo.resolve("location", text, lang=lang, limit=8)
    return [
        {"location_id": r.id, "full_name": r.full_name, "confidence": r.confidence}
        for r in out
    ]


async def resolve_tag(
    text: str, lang: str | None = None,
    *, catalog_repo: CatalogRepository,
) -> list[dict[str, Any]]:
    out = await catalog_repo.resolve("tag", text, lang=lang, limit=8)
    return [
        {"tag_id": r.id, "full_name": r.full_name, "confidence": r.confidence}
        for r in out
    ]


_RESOLVE_PARAMS = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "lang": {"type": "string"},
    },
    "required": ["text"],
}


register_tool(ToolDef(
    name="resolve_author",
    fn=resolve_author,
    description=(
        "Translate a human author name into author_id. Call BEFORE "
        "list_tracks/search_transcripts when filtering by author."
    ),
    parameters=_RESOLVE_PARAMS,
))

register_tool(ToolDef(
    name="resolve_source",
    fn=resolve_source,
    description=(
        "Translate a book/source name (e.g. 'Bhagavad-gita', "
        "'Шримад-Бхагаватам') into source_id."
    ),
    parameters=_RESOLVE_PARAMS,
))

register_tool(ToolDef(
    name="resolve_location",
    fn=resolve_location,
    description="Translate a location name (city, place) into location_id.",
    parameters=_RESOLVE_PARAMS,
))

register_tool(ToolDef(
    name="resolve_tag",
    fn=resolve_tag,
    description=(
        "Translate a tag name into tag_id. Includes kind-tags: "
        "'tag_morning_walk', 'tag_conversation', 'tag_lecture', "
        "'tag_initiation', 'tag_address', 'tag_festival', "
        "'tag_interview', 'tag_press_conf', 'tag_bhajan', "
        "'tag_vyasa_puja', 'tag_wedding', 'tag_other'."
    ),
    parameters=_RESOLVE_PARAMS,
))
