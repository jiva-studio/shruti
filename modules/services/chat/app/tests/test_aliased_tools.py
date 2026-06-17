"""Tests for the per-turn alias wrapper.

Two responsibilities under test:
- Envelope-wrapper auto-injects `alias_map` into tools that declare it.
- Legacy track-tool wrapper aliases track_id → ref on output and
  ref → track_id on input.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.aliased_tools import build_aliased_tools
from shruti_chat.agent.tools import build_personalized_tools
from shruti_chat.agent.tools._registry import all_tools
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


async def test_track_pdf_generate_dealiases_track_ids() -> None:
    """track_pdf_generate input list[int refs] → list[str track_ids]."""
    received: dict[str, Any] = {}

    async def fake_track_pdf_generate(*, track_ids: list[str], lang: str) -> dict:
        received["track_ids"] = track_ids
        return {"ok": True}

    aliases = TurnAliasMap()
    r1 = aliases.alias_track("track_A")
    r2 = aliases.alias_track("track_B")
    wrapped = build_aliased_tools(
        {"track_pdf_generate": fake_track_pdf_generate}, aliases,
    )
    await wrapped["track_pdf_generate"](track_ids=[r1, r2], lang="ru")

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


# --- Regression: personalize-then-alias must still inject alias_map ---------
#
# `chat_turn` composes the wrappers as
#   build_aliased_tools(build_personalized_tools(TOOLS, uc), aliases)
# A personalized tool that ALSO declares `alias_map` (the three user_* tools)
# is wrapped twice. Before the `@wraps` fix the personalize wrapper hid the
# underlying signature behind `**kwargs`, so `build_aliased_tools` could not
# see `alias_map` and never injected it — every call crashed the turn with
#   {"error": "bad args: ... missing 1 required keyword-only argument: 'alias_map'"}
# which is why "что послушать дальше" / "что я слушал" returned nothing.


def test_user_history_tools_are_personalized_and_aliased() -> None:
    """The three history/recommend tools are BOTH personalized and take
    `alias_map` — the exact combination the double-wrap regression broke."""
    defs = all_tools()
    for name in ("user_recommendations_get", "user_tracks_list", "user_history_search"):
        assert defs[name].personalized is True, name


async def test_personalized_then_aliased_injects_both() -> None:
    """A personalized + alias_map tool, wrapped in the real production order,
    receives the server-side user_context AND the per-turn alias_map."""
    received: dict[str, Any] = {}

    async def fake_user_tracks_list(
        *, user_context: Any = None, alias_map: TurnAliasMap, limit: int = 20,
    ) -> list[dict]:
        received["user_context"] = user_context
        received["alias_map"] = alias_map
        received["limit"] = limit
        return []

    # "user_tracks_list" is in the personalized set, so build_personalized_tools
    # wraps the fake; build_aliased_tools must then still inject alias_map.
    sentinel_ctx = object()
    personalized = build_personalized_tools(
        {"user_tracks_list": fake_user_tracks_list}, sentinel_ctx  # type: ignore[arg-type]
    )
    aliases = TurnAliasMap()
    aliased = build_aliased_tools(personalized, aliases)

    # The LLM only supplies `limit`; user_context + alias_map are injected.
    await aliased["user_tracks_list"](limit=5)

    assert received["user_context"] is sentinel_ctx
    assert received["alias_map"] is aliases
    assert received["limit"] == 5


async def test_personalized_rejects_llm_supplied_user_context() -> None:
    """Even when both wrappers are applied, an LLM-invented `user_context`
    is dropped in favour of the server-side one."""
    received: dict[str, Any] = {}

    async def fake(*, user_context: Any = None, alias_map: TurnAliasMap) -> list[dict]:
        received["user_context"] = user_context
        received["alias_map"] = alias_map
        return []

    server_ctx = object()
    aliased = build_aliased_tools(
        build_personalized_tools({"user_tracks_list": fake}, server_ctx),  # type: ignore[arg-type]
        TurnAliasMap(),
    )
    await aliased["user_tracks_list"](user_context="LLM-INVENTED")

    assert received["user_context"] is server_ctx
