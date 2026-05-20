"""Tests for `agent/graph/tool_adapter.py` — ToolDef → StructuredTool conversion.

Covers JSON-Schema → Pydantic conversion + yield_event injection. Each
real tool from the registry is round-tripped through `as_langchain_tool`
to catch unsupported schema shapes early (rather than at LangGraph
runtime).
"""

from __future__ import annotations

import inspect
from typing import Any

import pytest
from langchain_core.tools import StructuredTool

from lectorium_chat.agent.graph.tool_adapter import (
    _jsonschema_type_to_python,
    _schema_to_pydantic,
    as_langchain_tool,
)
from lectorium_chat.agent.tools import TOOLS
from lectorium_chat.agent.tools._registry import ToolDef, all_tools


# ── JSON-Schema → Python type ────────────────────────────────────────────

def test_primitive_types() -> None:
    assert _jsonschema_type_to_python({"type": "string"}) is str
    assert _jsonschema_type_to_python({"type": "integer"}) is int
    assert _jsonschema_type_to_python({"type": "number"}) is float
    assert _jsonschema_type_to_python({"type": "boolean"}) is bool


def test_array_of_string() -> None:
    py = _jsonschema_type_to_python({"type": "array", "items": {"type": "string"}})
    # list[str] equality is finicky across Python versions — use the
    # repr to assert the shape.
    assert "list" in repr(py) and "str" in repr(py)


def test_unsupported_type_raises() -> None:
    with pytest.raises(ValueError, match="unsupported"):
        _jsonschema_type_to_python({"type": "null"})


# ── Schema → Pydantic ─────────────────────────────────────────────────────

def test_required_field_has_no_default() -> None:
    Model = _schema_to_pydantic(
        "Test",
        {
            "type": "object",
            "properties": {"q": {"type": "string"}},
            "required": ["q"],
        },
    )
    with pytest.raises(Exception):  # Pydantic raises ValidationError
        Model()


def test_optional_field_defaults_to_none() -> None:
    Model = _schema_to_pydantic(
        "Test",
        {
            "type": "object",
            "properties": {"q": {"type": "string"}, "limit": {"type": "integer"}},
            "required": ["q"],
        },
    )
    instance = Model(q="hi")
    assert instance.limit is None


def test_optional_field_with_default_uses_it() -> None:
    Model = _schema_to_pydantic(
        "Test",
        {
            "type": "object",
            "properties": {"top_k": {"type": "integer", "default": 8}},
        },
    )
    instance = Model()
    assert instance.top_k == 8


def test_description_flows_through() -> None:
    Model = _schema_to_pydantic(
        "Test",
        {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "search query"},
            },
            "required": ["q"],
        },
    )
    field = Model.model_fields["q"]
    assert field.description == "search query"


def test_extras_ignored_not_rejected() -> None:
    Model = _schema_to_pydantic(
        "Test",
        {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
    )
    # LLM might invent an extra field; Pydantic must not blow up.
    instance = Model(q="hi", unknown_extra="value")  # type: ignore[call-arg]
    assert instance.q == "hi"


def test_non_object_schema_rejected() -> None:
    with pytest.raises(ValueError, match="type='object'"):
        _schema_to_pydantic("Test", {"type": "string"})


# ── as_langchain_tool with real registered tools ─────────────────────────

async def _noop_fn(**kwargs: Any) -> dict[str, Any]:
    return {"ok": True, "echo": kwargs}


def _make_def(name: str, parameters: dict[str, Any], *, emits_events: bool = False) -> ToolDef:
    return ToolDef(
        name=name,
        fn=_noop_fn,
        description="test tool",
        parameters=parameters,
        emits_events=emits_events,
    )


def test_as_langchain_tool_returns_structured_tool() -> None:
    td = _make_def(
        "echo_tool",
        {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
    )
    lt = as_langchain_tool(td, _noop_fn)
    assert isinstance(lt, StructuredTool)
    assert lt.name == "echo_tool"
    assert lt.description == "test tool"


def test_emits_events_requires_yield_event() -> None:
    td = _make_def(
        "side_effect_tool",
        {"type": "object", "properties": {}},
        emits_events=True,
    )
    with pytest.raises(ValueError, match="emits_events"):
        as_langchain_tool(td, _noop_fn)  # no yield_event provided


async def test_yield_event_injected_into_kwargs() -> None:
    captured: list[tuple[str, dict[str, Any]]] = []

    def writer(ev_type: str, data: dict[str, Any]) -> None:
        captured.append((ev_type, data))

    async def emitter_fn(*, yield_event, **kwargs: Any) -> dict[str, Any]:
        yield_event("test_event", {"k": "v"})
        return {"ok": True}

    td = _make_def(
        "emitter",
        {"type": "object", "properties": {}},
        emits_events=True,
    )
    lt = as_langchain_tool(td, emitter_fn, yield_event=writer)
    # ainvoke the underlying coroutine — LangChain dispatches this way.
    result = await lt.coroutine()  # type: ignore[misc]
    assert result == {"ok": True}
    assert captured == [("test_event", {"k": "v"})]


# ── All registered tools convert without errors ──────────────────────────

def test_all_real_tools_convert() -> None:
    """Iterate every registered tool in the live registry and ensure
    each converts to a StructuredTool. Catches schema-shape regressions
    introduced when a new tool is added or an existing one's parameters
    change."""
    defs = all_tools()
    assert len(defs) > 0, "registry empty — side-effect imports broken?"
    for name, td in defs.items():
        # emits_events tools need a yield_event in adapter — supply a noop.
        ye = (lambda _t, _d: None) if td.emits_events else None
        lt = as_langchain_tool(td, td.fn, yield_event=ye)
        assert isinstance(lt, StructuredTool), f"{name} did not convert"
        # args_schema must validate the parameters JSON Schema shape —
        # construct an empty instance for tools with no required fields
        # to catch obvious type-mismatch bugs.
        required = set(td.parameters.get("required", []))
        if not required:
            # Should construct cleanly with no args.
            lt.args_schema()
