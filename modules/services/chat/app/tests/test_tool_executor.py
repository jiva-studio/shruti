"""Tests for `agent/tool_executor.py` — the proactive-path dispatcher.

Covers the error envelopes the loop relies on (malformed JSON,
non-object arguments, unknown tool, wrong kwargs, raising tool) plus
the `lang` force-default for the discovery tools.

`bind_repositories` mutates a module-global TOOLS dict in place with no
unbind, so nothing here touches the real registry — the `tools` mapping
is always built inline.
"""

from __future__ import annotations

from typing import Any

import pytest

from lectorium_chat.agent.tool_executor import (
    ToolCallSpec,
    encode_tool_result,
    execute_tool_call,
)


async def _capture(**kwargs: Any) -> dict[str, Any]:
    """Echoes whatever kwargs it was called with."""
    return {"got": kwargs}


async def _run(
    name: str,
    arguments_json: str,
    *,
    tools: dict[str, Any] | None = None,
    emits_events: list[str] | None = None,
    lang: str = "ru",
):
    return await execute_tool_call(
        ToolCallSpec(id="c1", name=name, arguments_json=arguments_json),
        tools=tools if tools is not None else {name: _capture},
        emits_events=emits_events or [],
        lang=lang,
    )


@pytest.mark.asyncio
async def test_malformed_json_falls_back_to_empty_args() -> None:
    ex = await _run("plain_tool", "{not json at all")
    assert ex.result == {"got": {}}


@pytest.mark.asyncio
async def test_empty_arguments_string_is_empty_args() -> None:
    ex = await _run("plain_tool", "")
    assert ex.result == {"got": {}}


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", ["[]", "null", '"hi"', "3", '["a","b"]'])
async def test_non_object_args_do_not_kill_the_turn(payload: str) -> None:
    """A model that streams `arguments` parsing to a non-object must
    get a normal tool result, not an exception escaping to agent_error.
    `chunks_search` is the hot path: it also hits the `lang` default."""
    ex = await _run("chunks_search", payload)
    assert ex.result == {"got": {"lang": "ru"}}


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", ["[]", "null", '"hi"', "3"])
async def test_non_object_args_on_a_plain_tool(payload: str) -> None:
    """Same coercion for tools outside `_LANG_DEFAULT_TOOLS`."""
    ex = await _run("plain_tool", payload)
    assert ex.result == {"got": {}}


@pytest.mark.asyncio
async def test_unknown_tool_returns_error_dict() -> None:
    ex = await _run("hallucinated", "{}", tools={"plain_tool": _capture})
    assert "unknown tool" in ex.result["error"]
    assert ex.side_events == []


@pytest.mark.asyncio
async def test_wrong_kwargs_return_bad_args_error() -> None:
    async def strict(*, q: str) -> dict[str, Any]:
        return {"q": q}

    ex = await _run("strict", '{"nope": 1}', tools={"strict": strict})
    assert ex.result["error"].startswith("bad args: ")


@pytest.mark.asyncio
async def test_raising_tool_returns_error_dict() -> None:
    async def boom(**kwargs: Any) -> dict[str, Any]:
        raise ValueError("library.db is locked")

    ex = await _run("boom", "{}", tools={"boom": boom})
    assert ex.result == {"error": "library.db is locked"}


@pytest.mark.asyncio
async def test_lang_is_force_defaulted_for_discovery_tools() -> None:
    ex = await _run("tracks_list", '{"q": "karma"}', lang="ru")
    assert ex.result["got"] == {"q": "karma", "lang": "ru"}


@pytest.mark.asyncio
async def test_explicit_lang_wins_over_the_default() -> None:
    """`lang=null` is how the LLM asks to broaden across languages —
    the default must not overwrite it."""
    ex = await _run("chunks_search", '{"lang": null}', lang="ru")
    assert ex.result["got"] == {"lang": None}


@pytest.mark.asyncio
async def test_lang_default_not_applied_to_other_tools() -> None:
    ex = await _run("plain_tool", '{"q": "karma"}')
    assert ex.result["got"] == {"q": "karma"}


@pytest.mark.asyncio
async def test_yield_event_injected_and_side_events_collected() -> None:
    async def emitter(*, yield_event: Any) -> dict[str, Any]:
        yield_event("action", {"kind": "share_pdf"})
        return {"ok": True}

    ex = await _run(
        "emitter", "{}", tools={"emitter": emitter}, emits_events=["emitter"]
    )
    assert ex.result == {"ok": True}
    assert [(e.type, e.data) for e in ex.side_events] == [
        ("action", {"kind": "share_pdf"})
    ]


@pytest.mark.asyncio
async def test_list_result_reports_result_count() -> None:
    async def lister(**kwargs: Any) -> list[int]:
        return [1, 2, 3]

    ex = await _run("lister", "{}", tools={"lister": lister})
    assert ex.result_count == 3


def test_encode_tool_result_keeps_unicode_and_stringifies_unknowns() -> None:
    assert encode_tool_result({"q": "карма"}) == '{"q": "карма"}'
    assert encode_tool_result({"o": object()}).startswith('{"o": "<object')
