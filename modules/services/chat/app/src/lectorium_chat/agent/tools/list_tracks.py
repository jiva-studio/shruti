"""list_tracks — deterministic metadata filter over the catalog.

Delegates to `CatalogRepository.list_tracks` and reshapes results into
the wire format the agent expects. Includes the lang fallback: if the
requested-language EXISTS filter yields nothing, re-run without it so
the LLM can still surface English tracks to a Russian user (and see
each result's actual `lang`).
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.agent.tools._registry import ToolDef, register_tool
from lectorium_chat.domain.entities import Track
from lectorium_chat.domain.ports.catalog_repository import CatalogRepository


def _to_wire(track: Track) -> dict[str, Any]:
    return {
        "track_id": track.id,
        "title": track.title or "(untitled)",
        "lang": track.lang,
        "date": track.date,
        "author_id": track.author_id,
        "author_name": track.author_name,
        "location_id": track.location_id,
        "location_name": track.location_name,
        "tag_ids": list(track.tag_ids),
        "tag_names": list(track.tag_names),
        "duration_ms": track.duration_ms,
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


async def list_tracks(
    author_id: str | None = None,
    source_id: str | None = None,
    location_id: str | None = None,
    tag_ids: list[str] | None = None,
    title_query: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    lang: str | None = "ru",
    limit: int = 20,
    offset: int = 0,
    ref_prefix: str | None = None,
    ref_from: int | None = None,
    ref_to: int | None = None,
    *,
    catalog_repo: CatalogRepository,
) -> list[dict[str, Any]]:
    rows = await catalog_repo.list_tracks(
        author_id=author_id, source_id=source_id, location_id=location_id,
        tag_ids=tag_ids, title_query=title_query,
        date_from=date_from, date_to=date_to,
        lang=lang, limit=limit, offset=offset,
        ref_prefix=ref_prefix, ref_from=ref_from, ref_to=ref_to,
    )
    # Prefer tracks that have a transcript in the requested language; if
    # there are none, broaden — each Track carries its actual variant
    # language so the LLM can warn the user accordingly.
    if not rows and lang is not None:
        rows = await catalog_repo.list_tracks(
            author_id=author_id, source_id=source_id, location_id=location_id,
            tag_ids=tag_ids, title_query=title_query,
            date_from=date_from, date_to=date_to,
            lang=None, limit=limit, offset=offset,
            ref_prefix=ref_prefix, ref_from=ref_from, ref_to=ref_to,
        )
    return [_to_wire(t) for t in rows]


register_tool(ToolDef(
    name="tracks_list",
    fn=list_tracks,
    description=(
        "Deterministic metadata filter over the lecture catalog. Use "
        "for list-style queries: 'lectures by X from Y in period Z'. "
        "Returns tracks the synthesizer will render as `[card:N]` "
        "widgets — use the integer `ref` field from each row. "
        "Kind (morning walk / conversation / lecture / ...) is "
        "passed via tag_ids (e.g. ['tag_morning_walk']).\n\n"
        "**`title_query` is the way to find a lecture by name.** "
        "When the user says «найди лекцию «X»» / «перескажи лекцию X», "
        "pass the bare phrase (no quotes) as `title_query` — it runs "
        "FTS against the actual lecture titles (with prefix matching, "
        "accent-insensitive). chunks_search(type='lecture') searches the SPOKEN "
        "TEXT, not titles — don't use it for 'find lecture named X'.\n\n"
        "**Scripture chapter/verse — use `ref_prefix` + optional "
        "`ref_from`/`ref_to`.** «Гита 2» → source_id=<BG>, "
        "ref_prefix='2'. «Гита 2 стихи 10–30» → ref_prefix='2', "
        "ref_from=10, ref_to=30. «ШБ 2 песнь 3 глава» → source_id=<SB>, "
        "ref_prefix='2.3'. The format is dot-separated numbers; the "
        "filter ignores tracks whose reference has no verse data (intro "
        "lectures), so don't worry about them sneaking in."
    ),
    parameters={
        "type": "object",
        "properties": {
            "author_id": {"type": "string"},
            "source_id": {"type": "string"},
            "location_id": {"type": "string"},
            "tag_ids": {"type": "array", "items": {"type": "string"}},
            "title_query": {
                "type": "string",
                "description": "Fuzzy FTS query over track titles. Use for «найди лекцию X».",
            },
            "date_from": {"type": "string"},
            "date_to": {"type": "string"},
            "lang": {"type": "string", "enum": ["ru", "en"], "default": "ru"},
            "limit": {"type": "integer", "default": 20},
            "offset": {"type": "integer", "default": 0},
            "ref_prefix": {
                "type": "string",
                "description": (
                    "Scripture reference prefix as dot-separated numbers. "
                    "BG (2-level): '2' = chapter 2. SB/CC (3-level): '2.3' "
                    "= canto 2, chapter 3; '2' = canto 2 (all chapters). "
                    "Pair with source_id (BG/SB/etc.)."
                ),
            },
            "ref_from": {
                "type": "integer",
                "description": (
                    "Lower bound of the verse (last) number, inclusive. "
                    "Applies to the slot AFTER ref_prefix — i.e. the verse "
                    "within the chapter."
                ),
            },
            "ref_to": {
                "type": "integer",
                "description": "Upper bound of the verse number, inclusive.",
            },
        },
    },
))
