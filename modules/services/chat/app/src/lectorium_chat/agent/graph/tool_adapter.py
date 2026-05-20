"""Adapter: `ToolDef` (our registry) → `StructuredTool` (LangChain).

LangGraph's `create_react_agent` consumes `BaseTool` instances. Our tools
are registered as `ToolDef` with JSON-Schema parameters and an async
callable. This module bridges by:

1. Converting JSON-Schema `parameters` to a dynamic Pydantic model
   (LangChain's `args_schema`).
2. Wrapping the already-bound async fn so it injects `yield_event`
   into kwargs when the tool declares `emits_events=True`. The wrapper
   keeps the async signature LangChain expects.

`bound_fn` is the tool callable AFTER `bind_repositories +
build_personalized_tools + build_aliased_tools` have been applied —
this adapter doesn't touch those layers, it only handles the LangChain
boundary.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, ConfigDict, Field, create_model

from lectorium_chat.agent.tools._registry import ToolDef, ToolFn


YieldEvent = Callable[[str, dict[str, Any]], None]


# JSON-Schema primitive types we expect in tool parameter shapes. Anything
# beyond this is an unsupported shape — raise loudly rather than silently
# fall back to `Any` so a malformed tool registration surfaces in tests.
_PRIMITIVES: dict[str, type] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
}


def _jsonschema_type_to_python(schema: dict[str, Any]) -> Any:
    """Map one JSON-Schema property to its Python type annotation.

    Handles: string, integer, number, boolean, array (with `items`),
    object (degrades to `dict[str, Any]` — we don't have nested-schema
    tools today). `enum` doesn't change the Python type — Pydantic
    accepts the JSON-Schema enum via field constraints, not type narrowing.
    """
    t = schema.get("type")
    if t in _PRIMITIVES:
        return _PRIMITIVES[t]
    if t == "array":
        items = schema.get("items", {})
        return list[_jsonschema_type_to_python(items)]  # type: ignore[misc]
    if t == "object":
        return dict[str, Any]
    raise ValueError(f"unsupported JSON-Schema type: {t!r}")


def _schema_to_pydantic(name: str, schema: dict[str, Any]) -> type[BaseModel]:
    """Build a dynamic Pydantic model from a JSON-Schema object shape.

    `required` fields become required Pydantic fields; the rest get a
    default of None (or the schema's `default` if specified). Descriptions
    flow through so LangChain can show them in the model's tool-call docs.
    """
    if schema.get("type") != "object":
        raise ValueError(
            f"tool parameters schema must be type='object', got {schema.get('type')!r}"
        )
    properties: dict[str, Any] = schema.get("properties", {})
    required: set[str] = set(schema.get("required", []))

    fields: dict[str, Any] = {}
    for prop_name, prop_schema in properties.items():
        py_type = _jsonschema_type_to_python(prop_schema)
        description = prop_schema.get("description")
        is_required = prop_name in required
        has_default = "default" in prop_schema

        field_kwargs: dict[str, Any] = {}
        if description:
            field_kwargs["description"] = description

        if is_required:
            # Required: no default, type as declared.
            fields[prop_name] = (py_type, Field(..., **field_kwargs))
        elif has_default:
            # Optional with explicit default — keep the declared type;
            # the default ensures Pydantic accepts omission.
            fields[prop_name] = (py_type, Field(prop_schema["default"], **field_kwargs))
        else:
            # Optional without default — widen to `T | None`, default to None.
            fields[prop_name] = (py_type | None, Field(None, **field_kwargs))

    # `extra='ignore'` keeps Pydantic from rejecting extras the LLM might
    # invent — extras are dropped silently so a model "improving" the
    # schema doesn't bomb the tool call.
    return create_model(
        name,
        __config__=ConfigDict(extra="ignore"),
        **fields,
    )  # type: ignore[call-overload]


def as_langchain_tool(
    td: ToolDef,
    bound_fn: ToolFn,
    *,
    yield_event: YieldEvent | None = None,
) -> StructuredTool:
    """Wrap a `ToolDef` + already-bound async fn as a LangChain `StructuredTool`.

    `yield_event` is a per-turn callback that pushes side-events to the
    SSE writer (action / propose_cite / outline / verse). It MUST be
    provided when `td.emits_events` is True; the wrapper injects it
    into kwargs at call time.

    The returned `StructuredTool` exposes the tool to LangGraph via the
    standard `BaseTool` interface; `args_schema` is a freshly-generated
    Pydantic model so JSON-mode tool-calling validates the LLM's args
    before they reach our fn.
    """
    args_schema = _schema_to_pydantic(f"{td.name}_Args", td.parameters)

    if td.emits_events:
        if yield_event is None:
            raise ValueError(
                f"tool {td.name!r} has emits_events=True but no yield_event "
                "callback was provided — caller must wire one per turn"
            )

        async def _wrapped(**kwargs: Any) -> Any:
            kwargs["yield_event"] = yield_event
            return await bound_fn(**kwargs)

        impl: Callable[..., Awaitable[Any]] = _wrapped
    else:
        impl = bound_fn

    return StructuredTool.from_function(
        coroutine=impl,
        name=td.name,
        description=td.description,
        args_schema=args_schema,
    )
