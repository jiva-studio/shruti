"""Unit tests for chunks_get_by_address."""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools.chunks_get_by_address import chunks_get_by_address
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.entities import LibraryChunk


class _StubChunkRepo:
    def __init__(self, rows: list[LibraryChunk]) -> None:
        self.rows = rows
        self.calls: list[dict[str, Any]] = []

    async def get_chunks_by_addr_label(
        self, addr_label: str, *, kinds: list[str], lang: str | None = None,
    ) -> list[LibraryChunk]:
        self.calls.append({"addr": addr_label, "kinds": kinds, "lang": lang})
        return [
            r for r in self.rows
            if r.addr_label == addr_label and r.item_kind in kinds
            and (lang is None or r.lang == lang)
        ]


def _row(item_kind: str, addr: str = "БГ 2.13", lang: str = "ru") -> LibraryChunk:
    return LibraryChunk(
        item_id="x", item_kind=item_kind,
        source_id="BG", tokens="2.13",
        author_id=None, doc_date=None,
        lang=lang, segment_index=0,
        text=f"text-{item_kind}",
        addr_label=addr,
    )


async def test_verse_lookup_ru() -> None:
    repo = _StubChunkRepo([_row("verse")])
    rows = await chunks_get_by_address(
        type="verse", book="BG", tokens="2.13", lang="ru",
        chunk_repo=repo, alias_map=TurnAliasMap(),
    )
    assert isinstance(rows, list)
    assert len(rows) == 1
    assert rows[0]["type"] == "verse"
    assert rows[0]["label"] == "БГ 2.13"
    assert rows[0]["meta"] == {"source_id": "BG", "tokens": "2.13"}
    # Repo was queried with the composed addr_label.
    assert repo.calls == [{"addr": "БГ 2.13", "kinds": ["verse"], "lang": "ru"}]


async def test_commentary_lookup_en() -> None:
    repo = _StubChunkRepo([_row("commentary", addr="BG 2.13", lang="en")])
    rows = await chunks_get_by_address(
        type="commentary", book="BG", tokens="2.13", lang="en",
        chunk_repo=repo, alias_map=TurnAliasMap(),
    )
    assert len(rows) == 1
    assert rows[0]["type"] == "commentary"
    assert rows[0]["ref"] is None  # commentary doesn't mint a citation ref
    assert repo.calls == [{"addr": "BG 2.13", "kinds": ["commentary"], "lang": "en"}]


async def test_letter_returns_structured_error() -> None:
    repo = _StubChunkRepo([])
    result = await chunks_get_by_address(
        type="letter", book="anything", tokens="anything", lang="en",
        chunk_repo=repo, alias_map=TurnAliasMap(),
    )
    assert isinstance(result, dict)
    assert result["error"] == "unsupported_type"
    assert "hint" in result
    # No repo call when the type is invalid.
    assert repo.calls == []


async def test_unknown_book_returns_empty_list() -> None:
    repo = _StubChunkRepo([])
    rows = await chunks_get_by_address(
        type="verse", book="NOT_A_BOOK", tokens="2.13", lang="ru",
        chunk_repo=repo, alias_map=TurnAliasMap(),
    )
    assert rows == []
    assert repo.calls == []


async def test_prose_chapter_returns_structured_error() -> None:
    """Only verse/commentary are addressable; prose_chapter rejected."""
    repo = _StubChunkRepo([])
    result = await chunks_get_by_address(
        type="prose_chapter", book="BG", tokens="2.13", lang="en",
        chunk_repo=repo, alias_map=TurnAliasMap(),
    )
    assert isinstance(result, dict)
    assert result["error"] == "unsupported_type"
