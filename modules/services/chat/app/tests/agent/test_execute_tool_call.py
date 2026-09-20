"""`execute_tool_call` — the error envelope and the arg massaging.

The dispatcher is what stands between a model that invents a tool name or
hands over half-written JSON and the agent loop, which appends whatever comes
back into the message history. Every failure mode has to come out as a
`{"error": ...}` dict, never as an exception.

`tools` is a parameter, so nothing here touches the module-global `TOOLS` —
the tools are built per test, which is also why the double-wrapping in
`bind_repositories` (issue #1561) is not in the way.
"""

from __future__ import annotations

import json
from datetime import date
from typing import Any

import pytest

from lectorium_chat.agent.tool_executor import (
    ToolCallSpec,
    encode_tool_result,
    execute_tool_call,
)


def _call(name: str, arguments_json: str = "{}") -> ToolCallSpec:
    return ToolCallSpec(id="call-1", name=name, arguments_json=arguments_json)


def _recorder(result: Any = "ok"):
    """A tool that records the kwargs it was dispatched with."""
    seen: dict[str, Any] = {}

    async def _fn(**kwargs: Any) -> Any:
        seen.update(kwargs)
        return result

    return _fn, seen


async def _run(call: ToolCallSpec, tools: dict[str, Any], **kw: Any):
    return await execute_tool_call(
        call,
        tools=tools,
        emits_events=kw.pop("emits_events", ()),
        lang=kw.pop("lang", "ru"),
    )


async def test_unknown_tool_returns_an_error_envelope() -> None:
    ex = await _run(_call("no_such_tool"), {})
    assert ex.result == {"error": "unknown tool 'no_such_tool'"}
    assert ex.side_events == []


async def test_dispatches_parsed_arguments() -> None:
    fn, seen = _recorder()
    await _run(_call("outline", '{"track_id": "t1", "depth": 2}'), {"outline": fn})
    assert seen == {"track_id": "t1", "depth": 2}


async def test_malformed_argument_json_comes_back_as_an_error() -> None:
    """A truncated stream must not take the turn down, and must not be run as
    if the model had asked for the defaults either: calling `outline` with no
    track_id is a different request from the one that was truncated. The loop
    gets an error envelope and the tool is never reached (#1554)."""
    calls: list[dict[str, Any]] = []

    async def _fn(**kwargs: Any) -> Any:
        calls.append(kwargs)
        return "ok"

    ex = await _run(_call("outline", '{"track_id": "t1"'), {"outline": _fn})
    assert calls == []
    assert "bad JSON in tool args" in ex.result["error"]


async def test_empty_argument_string_is_treated_as_no_arguments() -> None:
    fn, seen = _recorder()
    await _run(_call("outline", ""), {"outline": fn})
    assert seen == {}


@pytest.mark.parametrize("tool_name", ["chunks_search", "tracks_list"])
async def test_ui_language_is_injected_into_discovery_tools(tool_name: str) -> None:
    fn, seen = _recorder()
    await _run(_call(tool_name, '{"query": "karma"}'), {tool_name: fn}, lang="ru")
    assert seen["lang"] == "ru"


@pytest.mark.parametrize("explicit", ['{"lang": "en"}', '{"lang": null}'])
async def test_an_explicit_language_is_never_overwritten(explicit: str) -> None:
    """`lang=null` is how the LLM asks to broaden across languages; forcing
    the UI locale back in would make that impossible."""
    fn, seen = _recorder()
    expected = json.loads(explicit)["lang"]
    await _run(_call("chunks_search", explicit), {"chunks_search": fn}, lang="ru")
    assert seen["lang"] == expected


async def test_other_tools_get_no_language_default() -> None:
    fn, seen = _recorder()
    await _run(_call("outline", '{"track_id": "t1"}'), {"outline": fn}, lang="ru")
    assert "lang" not in seen


async def test_bad_arguments_come_back_as_an_error_not_an_exception() -> None:
    async def _fn(*, track_id: str) -> str:
        return track_id

    ex = await _run(_call("outline", '{"nope": 1}'), {"outline": _fn})
    assert isinstance(ex.result, dict)
    assert ex.result["error"].startswith("bad args: ")


async def test_a_raising_tool_comes_back_as_an_error_envelope() -> None:
    async def _fn(**_kw: Any) -> Any:
        raise RuntimeError("catalog is down")

    ex = await _run(_call("outline"), {"outline": _fn})
    assert ex.result == {"error": "catalog is down"}
    assert ex.result_count == 0


async def test_list_results_are_counted() -> None:
    fn, _ = _recorder(result=[{"id": 1}, {"id": 2}, {"id": 3}])
    ex = await _run(_call("outline"), {"outline": fn})
    assert ex.result_count == 3


async def test_scalar_results_count_as_one() -> None:
    fn, _ = _recorder(result={"id": 1})
    ex = await _run(_call("outline"), {"outline": fn})
    assert ex.result_count == 1


async def test_duration_is_recorded() -> None:
    fn, _ = _recorder()
    ex = await _run(_call("outline"), {"outline": fn})
    assert ex.duration_ms >= 0


async def test_event_emitting_tools_receive_a_sink_and_their_events_are_drained() -> None:
    async def _fn(*, yield_event: Any) -> str:
        yield_event("tool_progress", {"stage": "searching"})
        yield_event("tool_progress", {"stage": "ranking"})
        return "done"

    ex = await _run(_call("outline"), {"outline": _fn}, emits_events={"outline"})
    assert [e.type for e in ex.side_events] == ["tool_progress", "tool_progress"]
    assert ex.side_events[1].data == {"stage": "ranking"}
    assert ex.result == "done"


async def test_non_emitting_tools_are_not_handed_a_sink() -> None:
    fn, seen = _recorder()
    await _run(_call("outline"), {"outline": fn}, emits_events={"chunks_search"})
    assert "yield_event" not in seen


async def test_encode_tool_result_keeps_non_ascii_readable() -> None:
    """`ensure_ascii=False` — the encoded result goes back into the prompt,
    where escaped Cyrillic would burn tokens and confuse the model."""
    assert encode_tool_result({"title": "Бхагавад-гита"}) == '{"title": "Бхагавад-гита"}'


async def test_encode_tool_result_stringifies_unserialisable_values() -> None:
    """`default=str` — a repository handing back a date must not break the
    message-history append."""
    assert encode_tool_result({"d": date(2026, 8, 10)}) == '{"d": "2026-08-10"}'
