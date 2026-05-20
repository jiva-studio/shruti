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

from lectorium_chat.agent.tools._envelope import library_to_envelope
from lectorium_chat.agent.tools._helpers import BOOK_PREFIX
from lectorium_chat.agent.tools._registry import ToolDef, register_tool
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain.ports.chunk_repository import ChunkRepository


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
    return [library_to_envelope(c, alias_map=alias_map) for c in chunks]


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
                    "Canonical book code. One of: "
                    "BG (Bhagavad-gītā / Бхагавад-гита), "
                    "SB (Śrīmad-Bhāgavatam / Шримад-Бхагаватам), "
                    "'CC Adi' (Caitanya-caritāmṛta Ādi-līlā), "
                    "'CC Madhya', 'CC Antya', "
                    "BS (Brahma-saṁhitā), ISO (Śrī Īśopaniṣad), "
                    "NoI (Nectar of Instruction / Upadeśāmṛta), "
                    "MM (Mukunda-mālā-stotra), NBS (Nārada Bhakti Sūtra)."
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
