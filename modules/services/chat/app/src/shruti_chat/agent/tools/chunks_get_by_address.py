"""chunks_get_by_address — deterministic verse/commentary lookup.

Replaces `get_verse` and `get_commentary`. Same flow as before — extract
`book` + `tokens` from the user's phrasing, compose the canonical
`addr_label` per language, equality-query the chunks table.

Only `type='verse'` and `type='commentary'` are addressable this way.
Letters / prose chapters have free-form addr_labels and no stable
"book + tokens" grammar — for those, use `chunks_search` with filters.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools._envelope import (
    _AUTHORED_KINDS,
    library_to_envelope,
    resolve_commentary_author_names,
)
from shruti_chat.agent.tools._helpers import BOOK_PREFIX
from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.domain.ports.chunk_repository import ChunkRepository


_ALLOWED_TYPES = ("verse", "commentary")


_DESCRIPTION = (
    "DETERMINISTIC lookup of a SPECIFIC verse OR its commentary by "
    "canonical address. Call this FIRST when the user names a specific "
    "verse (\"БГ 2.13\", \"second chapter verse 13 of Bhagavad-gita\", "
    "\"Бхагаватам 5.5.3\", \"CC Madhya 12.138\", \"комментарий к БГ "
    "2.13\", \"purport on SB 5.5.3\"). Extract `book` and `tokens` from "
    "any phrasing and pass `type='verse'` for the verse body or "
    "`type='commentary'` for Prabhupāda's purport. Returns 0-2 rows "
    "(one per language). For letters / prose chapters there's no "
    "stable address grammar — use `chunks_search` with filters there."
)


async def chunks_get_by_address(
    type: str,
    book: str,
    tokens: str,
    lang: str,
    *,
    chunk_repo: ChunkRepository,
    catalog_repo: CatalogRepository | None = None,
    alias_map: TurnAliasMap,
) -> list[dict[str, Any]] | dict[str, Any]:
    if type not in _ALLOWED_TYPES:
        return {
            "error": "unsupported_type",
            "hint": (
                f"`chunks_get_by_address` accepts only {list(_ALLOWED_TYPES)} "
                "— letters / prose chapters have free-form addresses. "
                "Use `chunks_search` with `type=...` filters instead."
            ),
        }
    prefix_map = BOOK_PREFIX.get(book)
    if prefix_map is None:
        return []
    addr = f"{prefix_map[lang]} {tokens}"
    chunks = await chunk_repo.get_chunks_by_addr_label(
        addr, kinds=[type], lang=lang,
    )
    # Resolve human author names for commentary rows so a purport fetched
    # by this (FIRST-choice) named-verse path carries its attribution —
    # same enrichment `chunks_search` does. Without it `library_to_envelope`
    # mints the commentary with only `author_id`, and the synthesizer
    # blockquote renders "ШБ 5.5.3" with no author. Best-effort: missing
    # catalog → empty map → falls back to address-only attribution.
    names = await resolve_commentary_author_names(
        chunks, catalog_repo=catalog_repo, lang=lang,
    )
    out: list[dict[str, Any]] = []
    for c in chunks:
        extra = None
        if c.item_kind in _AUTHORED_KINDS and c.author_id:
            name = names.get(c.author_id)
            if name:
                extra = {"author_name": name}
        out.append(
            library_to_envelope(c, alias_map=alias_map, extra_meta=extra)
        )
    return out


register_tool(ToolDef(
    name="chunks_get_by_address",
    fn=chunks_get_by_address,
    description=_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "type": {
                "type": "string",
                "enum": list(_ALLOWED_TYPES),
                "description": (
                    "`verse` for the canonical text, `commentary` for "
                    "Prabhupāda's purport on that same verse."
                ),
            },
            "book": {
                "type": "string",
                "description": (
                    # Written from BOOK_PREFIX rather than typed out beside
                    # it: this tool matches an address label it builds from
                    # that map, so a book missing there cannot be addressed no
                    # matter what the description promises. Two hand-kept
                    # copies of one list is how «Шикшаштака» got answered out
                    # of the Nārada-bhakti-sūtra.
                    "Canonical book code, one of: "
                    + ", ".join(BOOK_PREFIX)
                    + ". Anything else has no verse addresses here."
                ),
            },
            "tokens": {
                "type": "string",
                "description": (
                    "Verse address inside the book, exactly as it appears "
                    "after the book label. E.g. '2.13' for BG 2.13, '5.5.3' "
                    "for SB 5.5.3, '1.1' for CC Adi 1.1, '1.2.28,1.2.29' "
                    "for a compound verse."
                ),
            },
            "lang": {
                "type": "string",
                "enum": ["ru", "en"],
                "description": "User's UI language. Pass it through verbatim from the conversation context.",
            },
        },
        "required": ["type", "book", "tokens", "lang"],
    },
))
