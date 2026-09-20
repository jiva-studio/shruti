"""Tool dispatch for the agent loop.

Given a single buffered tool call (id + name + raw JSON arg string),
parses arguments, applies the default-language injection for
discovery tools, dispatches the call, drains side events, and returns
the result envelope the loop appends back into the message history.

Pure orchestration — no SQL, no HTTP, no streaming state.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from shruti_chat.agent.events import AgentEvent
from shruti_chat.agent.tools._registry import ToolFn
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


# Discovery tools where the agent loop force-defaults `lang` to the
# request's UI language unless the LLM explicitly picked one. The
# per-tool fallback (search/tracks_list/history/recommend) then broadens
# transparently on empty result sets.
_LANG_DEFAULT_TOOLS = frozenset({"chunks_search", "tracks_list"})

_JSON_TYPE_NAMES: dict[type, str] = {
    dict: "object",
    list: "array",
    str: "string",
    bool: "boolean",
    int: "number",
    float: "number",
    type(None): "null",
}


def json_type_name(value: Any) -> str:
    """JSON-vocabulary name for a parsed value, for error messages."""
    return _JSON_TYPE_NAMES.get(type(value), type(value).__name__)


def parse_tool_args(
    arguments_json: str, *, tool: str
) -> tuple[dict[str, Any] | None, str | None]:
    """Parse a streamed `arguments` string into kwargs, or `(None, error)`.

    Anything that is not a JSON object is an error the model has to fix,
    never a coercion to `{}`. Coercing is unsafe: for a tool whose
    parameters are all optional (`list_tracks`) empty kwargs is a VALID
    call, so the model would get an unfiltered catalog page it never asked
    for and cite it. Both branches log — the malformed-argument rate is
    otherwise invisible, since the coerced args are what got logged.
    """
    try:
        args = json.loads(arguments_json or "{}")
    except json.JSONDecodeError as exc:
        log.warning("tool_args_malformed", tool=tool, error=str(exc))
        return None, f"bad JSON in tool args: {exc}"
    if not isinstance(args, dict):
        received = json_type_name(args)
        log.warning("tool_args_not_an_object", tool=tool, received_type=received)
        return None, f"tool args must be a JSON object, got {received}"
    return args, None


@dataclass
class ToolCallSpec:
    """One buffered tool call coming out of the streaming completion."""

    id: str
    name: str
    arguments_json: str


@dataclass
class ToolExecution:
    """Outcome of dispatching one tool call."""

    side_events: list[AgentEvent] = field(default_factory=list)
    result: Any = None
    duration_ms: int = 0
    result_count: int = 0


async def execute_tool_call(
    call: ToolCallSpec,
    *,
    tools: dict[str, ToolFn],
    emits_events: Iterable[str],
    lang: str,
    request_id: str | None = None,
) -> ToolExecution:
    exec_ = ToolExecution()
    args, args_error = parse_tool_args(call.arguments_json, tool=call.name)
    if args is None:
        exec_.result = {"error": args_error}
        return exec_

    # Reasoning for the default: a Russian-language UI session asking
    # «что Прабхупада говорил про X» almost always wants RU material if
    # available. To broaden across languages, the LLM passes
    # `lang=null` / `lang="en"` explicitly.
    if call.name in _LANG_DEFAULT_TOOLS and "lang" not in args:
        args["lang"] = lang

    fn = tools.get(call.name)
    if fn is None:
        exec_.result = {"error": f"unknown tool {call.name!r}"}
        return exec_

    side_buf = exec_.side_events

    def yield_event(ev_type: str, data: dict[str, Any]) -> None:
        side_buf.append(AgentEvent(type=ev_type, data=data))

    t0 = time.monotonic()
    call_kwargs = dict(args)
    if call.name in emits_events:
        call_kwargs["yield_event"] = yield_event
    try:
        result: Any = await fn(**call_kwargs)
    except TypeError as exc:
        result = {"error": f"bad args: {exc}"}
        exec_.result = result
    except Exception as exc:
        log.exception("tool_call_error", tool=call.name, error=str(exc))
        result = {"error": str(exc)}
        exec_.result = result
    else:
        exec_.result = result
        exec_.result_count = len(result) if isinstance(result, list) else 1

    exec_.duration_ms = int((time.monotonic() - t0) * 1000)
    log.info(
        "tool_call",
        request_id=request_id,
        tool_name=call.name,
        args=args,
        duration_ms=exec_.duration_ms,
        result_count=exec_.result_count,
        side_events=len(exec_.side_events),
    )
    return exec_


def encode_tool_result(result: Any) -> str:
    """JSON-encode a tool result for the message-history append.

    Pulled out of the loop so the encoding (ensure_ascii=False,
    default=str) lives in one place — handy when fixtures or tests
    need to reproduce the on-wire byte shape.
    """
    return json.dumps(result, ensure_ascii=False, default=str)
