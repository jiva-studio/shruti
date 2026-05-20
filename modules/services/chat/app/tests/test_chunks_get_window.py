"""Unit tests for chunks_get_window — track_ref resolution and errors."""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools.chunks_get_window import chunks_get_window
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.entities import Chunk


class _StubChunkRepo:
    def __init__(self, rows: list[Chunk]) -> None:
        self.rows = rows
        self.calls: list[dict[str, Any]] = []

    async def get_window(
        self, track_id: str, around_ms: int, *,
        window_ms: int, lang: str | None = None, max_chunks: int = 6,
    ) -> list[Chunk]:
        self.calls.append({
            "track_id": track_id, "around_ms": around_ms,
            "window_ms": window_ms, "lang": lang,
        })
        return self.rows


async def test_window_resolves_track_ref_to_real_track_id() -> None:
    repo = _StubChunkRepo([
        Chunk(track_id="track_X", lang="ru",
              start_ms=12_000, end_ms=15_000,
              text="hello", reference_source_id=None),
    ])
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 11_500, 16_000)

    rows = await chunks_get_window(
        track_ref=ref, around_ms=13_500, window_seconds=60,
        chunk_repo=repo, alias_map=aliases,
    )
    assert isinstance(rows, list)
    assert len(rows) == 1
    assert rows[0]["type"] == "lecture"
    # Real track_id was passed to the repo (stripped from LLM output).
    assert repo.calls[0]["track_id"] == "track_X"
    assert repo.calls[0]["around_ms"] == 13_500


async def test_invalid_track_ref_returns_structured_error() -> None:
    repo = _StubChunkRepo([])
    result = await chunks_get_window(
        track_ref=9_999_999,  # not in alias map
        around_ms=1_000,
        chunk_repo=repo, alias_map=TurnAliasMap(),
    )
    assert isinstance(result, dict)
    assert result["error"] == "invalid_ref"
    assert "hint" in result
    # Repo was NOT called.
    assert repo.calls == []


async def test_verse_ref_rejected_as_track_ref() -> None:
    """A ref minted for a verse must not resolve as a lecture window arg."""
    repo = _StubChunkRepo([])
    aliases = TurnAliasMap()
    verse_ref = aliases.alias_verse("BG", "2.13")

    result = await chunks_get_window(
        track_ref=verse_ref, around_ms=1_000,
        chunk_repo=repo, alias_map=aliases,
    )
    assert isinstance(result, dict)
    assert result["error"] == "invalid_ref"
    assert repo.calls == []


async def test_window_seconds_converted_to_ms() -> None:
    repo = _StubChunkRepo([])
    aliases = TurnAliasMap()
    ref = aliases.alias_chunk("track_X", 0, 1000)

    await chunks_get_window(
        track_ref=ref, around_ms=500, window_seconds=30,
        chunk_repo=repo, alias_map=aliases,
    )
    # 30s * 1000 = 30_000ms
    assert repo.calls[0]["window_ms"] == 30_000
