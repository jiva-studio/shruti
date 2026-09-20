"""Tests for `agent/tool_executor.py` — the proactive-path dispatcher.

Covers the error envelopes the loop relies on (malformed JSON,
non-object arguments, unknown tool, wrong kwargs, raising tool) plus
the `lang` force-default for the discovery tools.

`bind_repositories` mutates a module-global TOOLS dict in place with no
unbind, so nothing here touches the real registry — the `tools` mapping
is always built inline.
"""

from __future__ import annotations

from functools import partial
from typing import Any

import pytest

from lectorium_chat.agent import tool_executor
from lectorium_chat.agent.tool_executor import (
    ToolCallSpec,
    encode_tool_result,
    execute_tool_call,
)
from lectorium_chat.agent.tools.list_tracks import list_tracks
from lectorium_chat.domain.entities import Track


def _track(track_id: str) -> Track:
    return Track(
        id=track_id, title=f"Lecture {track_id}", lang="ru", date="1975-01-01",
        author_id="a1", author_name="Author", location_id="l1",
        location_name="Location", tag_ids=(), tag_names=(),
        duration_ms=None, references=(),
    )


_TRACKS = [_track("t1"), _track("t2"), _track("t3")]


class _CountingCatalog:
    """Enough of CatalogRepository for `list_tracks`, counting reads so a
    test can assert the catalog was never paged."""

    def __init__(self, tracks: list[Track]) -> None:
        self._tracks = tracks
        self.calls = 0

    async def list_tracks(self, *, limit: int, offset: int = 0, **_kw: Any):
        self.calls += 1
        return self._tracks[offset : offset + limit]


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
async def test_malformed_json_returns_error_without_calling_the_tool() -> None:
    called: list[Any] = []

    async def spy(**kwargs: Any) -> dict[str, Any]:
        called.append(kwargs)
        return {"got": kwargs}

    ex = await _run("plain_tool", "{not json at all", tools={"plain_tool": spy})
    assert "bad JSON in tool args" in ex.result["error"]
    assert called == []


@pytest.mark.asyncio
async def test_empty_arguments_string_is_empty_args() -> None:
    """A missing/empty `arguments` string IS a valid no-argument call —
    only a payload that parses to a non-object is an error."""
    ex = await _run("plain_tool", "")
    assert ex.result == {"got": {}}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "received"),
    [
        ("[]", "array"),
        ('["a","b"]', "array"),
        ("null", "null"),
        ('"hi"', "string"),
        ("3", "number"),
        ("true", "boolean"),
    ],
)
async def test_non_object_args_return_an_error(payload: str, received: str) -> None:
    """Args that parse to a non-object come back as a tool error the model
    can correct. Coercing them to `{}` would be worse than the crash it
    replaced: on a tool with no required parameters the call SUCCEEDS and
    the model cites a result it never asked for."""
    ex = await _run("chunks_search", payload)
    assert ex.result == {
        "error": f"tool args must be a JSON object, got {received}"
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", ["[]", "null", '"hi"', "3"])
async def test_non_object_args_never_reach_the_tool(payload: str) -> None:
    called: list[Any] = []

    async def spy(**kwargs: Any) -> dict[str, Any]:
        called.append(kwargs)
        return {"got": kwargs}

    ex = await _run("plain_tool", payload, tools={"plain_tool": spy})
    assert called == []
    assert ex.result["error"].startswith("tool args must be a JSON object")


@pytest.mark.asyncio
async def test_non_object_args_do_not_list_the_whole_catalog() -> None:
    """The regression this whole path exists for. `list_tracks` (registered
    as `tracks_list`) has no required parameters, so `[]` coerced to `{}`
    returns a full unfiltered catalog page that the synthesizer renders as
    `[^N]` citations — a silent wrong answer. It must error instead, and
    never touch the repository."""
    catalog = _CountingCatalog(_TRACKS)
    tools = {"tracks_list": partial(list_tracks, catalog_repo=catalog)}

    ex = await _run("tracks_list", "[]", tools=tools)

    assert ex.result == {"error": "tool args must be a JSON object, got array"}
    assert catalog.calls == 0
    assert ex.result_count == 0

    # Same tool, same fake repo: a well-formed call DOES page the catalog,
    # so the assertion above is about the arguments and not a dead tool.
    ok = await _run("tracks_list", '{"limit": 2}', tools=tools)
    assert [t["track_id"] for t in ok.result] == ["t1", "t2"]
    assert catalog.calls == 1


@pytest.mark.asyncio
async def test_non_object_args_are_logged_as_a_warning(monkeypatch) -> None:
    """The malformed-argument rate has to be visible in prod — the old
    code logged the already-coerced `args={}`, which showed nothing."""
    seen: list[tuple[str, dict[str, Any]]] = []

    class _Log:
        def warning(self, event: str, **kw: Any) -> None:
            seen.append((event, kw))

        def __getattr__(self, _name: str) -> Any:
            return lambda *a, **kw: None

    monkeypatch.setattr(tool_executor, "log", _Log())
    await _run("tracks_list", "[]", tools={"tracks_list": _capture})

    assert seen == [
        ("tool_args_not_an_object", {"tool": "tracks_list", "received_type": "array"})
    ]


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
