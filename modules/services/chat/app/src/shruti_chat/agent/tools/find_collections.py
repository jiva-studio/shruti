"""find_collections — name search over curated collections (seminars).

Returns collections (id, name, description, ordered track ids) the synthesizer
can offer the user to add wholesale. With no query, returns the featured set.
This is a METADATA name search (LIKE over collection names), not a semantic
search over spoken text — for "find the seminar named X", not "lectures about X".
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.domain.entities import Collection
from shruti_chat.domain.ports.catalog_repository import CatalogRepository


def _to_wire(c: Collection) -> dict[str, Any]:
    # Deliberately NO raw track_ids: the chat alias invariant is that the LLM
    # only ever sees integer refs, never real ids. The client resolves a
    # collection's tracks itself (it has the catalog DB) from `collection_id`.
    return {
        "collection_id": c.id,
        "name": c.name,
        "description": c.description,
        "track_count": len(c.track_ids),
    }


async def find_collections(
    query: str | None = None,
    lang: str | None = "ru",
    limit: int = 10,
    *,
    catalog_repo: CatalogRepository,
) -> list[dict[str, Any]]:
    rows = await catalog_repo.search_collections(query, lang=lang, limit=limit)
    # Lang fallback mirrors tracks_list: a RU user may still be offered an
    # EN-only collection rather than an empty result.
    if not rows and lang is not None and query:
        rows = await catalog_repo.search_collections(query, lang=None, limit=limit)
    return [_to_wire(c) for c in rows]


register_tool(ToolDef(
    name="collections_find",
    fn=find_collections,
    description=(
        "Find curated collections — multi-lecture seminars / series (e.g. a "
        "seminar on Iśopaniṣad, or Nectar of Devotion) — by name. With no "
        "query, returns the featured collections. Use when the user asks for a "
        "seminar / cycle / course, or wants to add a whole collection at once. "
        "Each result carries `collection_id`, `name`, `description` and the "
        "ordered `track_ids`; offer to add the whole collection. This is a "
        "name search (not semantic): for «семинар по X» / «найди курс X», not "
        "«лекции про X» (use chunks_search / tracks_list for those)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Collection-name fragment. Omit for the featured set.",
            },
            "lang": {"type": "string", "enum": ["ru", "en"], "default": "ru"},
            "limit": {"type": "integer", "default": 10},
        },
    },
))
