"""Tests for the per-turn alias wrapper.

Two responsibilities under test:
- Envelope-wrapper auto-injects `alias_map` into tools that declare it.
- Legacy track-tool wrapper aliases track_id → ref on output and
  ref → track_id on input.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.aliased_tools import build_aliased_tools
from shruti_chat.agent.turn_aliases import TurnAliasMap


async def test_envelope_wrapper_injects_alias_map() -> None:
    """A tool with `alias_map` param gets it auto-injected."""
    received: dict[str, Any] = {}

    async def my_chunk_tool(*, query: str, alias_map: TurnAliasMap) -> list[dict]:
        received["alias_map"] = alias_map
        received["query"] = query
        return []

    aliases = TurnAliasMap()
    wrapped = build_aliased_tools({"my_chunk_tool": my_chunk_tool}, aliases)
    await wrapped["my_chunk_tool"](query="x")

    assert received["alias_map"] is aliases
    assert received["query"] == "x"


async def test_legacy_track_list_aliases_track_id_to_ref() -> None:
    """list_tracks results: track_id → integer ref, track_id stripped."""
    async def fake_list_tracks() -> list[dict]:
        return [
            {"track_id": "real_track_X", "title": "Lec X"},
            {"track_id": "real_track_Y", "title": "Lec Y"},
        ]

    aliases = TurnAliasMap()
    wrapped = build_aliased_tools({"tracks_list": fake_list_tracks}, aliases)
    out = await wrapped["tracks_list"]()

    for row in out:
        assert "track_id" not in row
        assert isinstance(row["ref"], int)
    # Refs resolve back to real track_ids via the same alias map.
    refs = [r["ref"] for r in out]
    resolved = [aliases.resolve(r) for r in refs]
    assert {r.track_id for r in resolved} == {"real_track_X", "real_track_Y"}


async def test_legacy_propose_playlist_dealiases_track_ids() -> None:
    """propose_playlist input list[int refs] → list[str track_ids]."""
    received: dict[str, Any] = {}

    async def fake_propose_playlist(*, track_ids: list[str], name: str) -> dict:
        received["track_ids"] = track_ids
        return {"ok": True}

    aliases = TurnAliasMap()
    r1 = aliases.alias_track("track_A")
    r2 = aliases.alias_track("track_B")
    wrapped = build_aliased_tools({"playlist_propose": fake_propose_playlist}, aliases)
    await wrapped["playlist_propose"](track_ids=[r1, r2], name="mix")

    # Underlying fn saw real track_ids, not refs.
    assert received["track_ids"] == ["track_A", "track_B"]


async def test_get_track_single_ref_input_dealiased() -> None:
    received: dict[str, Any] = {}

    async def fake_get_track(*, track_id: str, lang: str) -> dict:
        received["track_id"] = track_id
        return {"track_id": track_id, "title": "Lec"}

    aliases = TurnAliasMap()
    ref = aliases.alias_track("real_track")
    wrapped = build_aliased_tools({"track_get": fake_get_track}, aliases)
    out = await wrapped["track_get"](track_id=ref, lang="ru")

    # Underlying fn got the real id.
    assert received["track_id"] == "real_track"
    # Output's track_id stripped to ref again.
    assert "track_id" not in out
    assert isinstance(out["ref"], int)


async def test_unknown_tool_passes_through() -> None:
    """Tools matching neither alias_map injection nor legacy table run as-is."""
    async def random_tool(*, x: int) -> int:
        return x * 2

    aliases = TurnAliasMap()
    wrapped = build_aliased_tools({"random_tool": random_tool}, aliases)
    # Returns identical callable — no wrapping needed.
    assert wrapped["random_tool"] is random_tool
