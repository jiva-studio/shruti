"""Application use-case: a multi-step ReAct loop that researches
the corpus for the synthesizer's grounding.

Pure: takes an `LLMPort` + tools + aliases via parameters. No
LangGraph imports — adapter in `agent/graph/nodes/research_worker.py`
threads context.aliases / context.llm into the call.

The loop is intentionally simple: streaming completion → parse
tool_calls → dispatch via the tool registry → append result to
messages → loop until LLM stops calling tools (or `max_turns`
ceiling). Prose the LLM might emit between tool calls is captured
for the bypass-marker audit but NOT streamed to the client —
synthesizer is the only node that streams text.

Cross-kind iteration is natural: lecture chunk mentions BG 4.17 →
LLM picks `chunks_get_by_address(type=verse, ...)` → result → LLM
picks `chunks_get_by_address(type=commentary, ...)` → result →
stop. The worker's toolset includes all five chunk kinds (see plan
section 5.0.1).
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Literal, Protocol, TypeVar

from pydantic import BaseModel

from shruti_chat.agent.tools._registry import ToolFn
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.entities import CompletionChunk, Message
from shruti_chat.observability.logging import get_logger


# Callback signature for tool lifecycle events. Workers bridge this to
# the SSE writer so the client shows "thinking" UI while a tool runs.
# event ∈ {"tool_start", "tool_end"}; payload carries the tool name.
ToolLifecycleCallback = Callable[[Literal["tool_start", "tool_end"], str], None]

# Callback signature for side-channel events emitted from inside a tool
# (currently only `action` events — `{kind, id, payload}`). Workers
# bridge this to the SSE writer so an action-producing tool
# (track_pdf_generate, …) actually delivers its
# payload to the client. The callback's first arg is the SSE event
# type (always "action" today, kept generic for future channels), and
# the second is the JSON-serializable event data.
YieldEventCallback = Callable[[str, dict[str, Any]], None]


log = get_logger(__name__)
T = TypeVar("T", bound=BaseModel)

# Per-worker max ReAct turns. Research needs the most headroom because
# cross-kind multi-step (lecture → verse → commentary) eats turns
# quickly. Other workers (catalog, action, help) get their own limit
# set at the node level — see plan Open Question #9.
DEFAULT_MAX_TURNS = 7


class _LLMForResearch(Protocol):
    """Minimal LLMPort subset needed by research. Narrowed so the
    spec isn't tied to the full LLMPort surface — easier mocking."""

    async def stream_completion(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> AsyncIterator[CompletionChunk]: ...


@dataclass
class ResearchResult:
    """What the research worker hands to the synthesizer.

    `tool_results` is appended in dispatch order. Synthesizer reads
    them to construct grounded responses; alias minting happened as
    a side-effect inside each tool fn (via `build_aliased_tools`).
    """

    tool_results: list[dict[str, Any]] = field(default_factory=list)
    n_turns: int = 0
    # Hit the cap without converging — synthesizer should mention this
    # explicitly ("я не нашёл / поиск занял слишком много шагов") so
    # the user knows the answer may be incomplete.
    hit_max_turns: bool = False


@dataclass
class _ToolCallAccumulator:
    """Buffer that re-assembles streamed tool-call fragments."""

    by_index: dict[int, dict[str, Any]] = field(default_factory=dict)

    def consume(self, deltas: list[dict[str, Any]] | None) -> None:
        if not deltas:
            return
        for d in deltas:
            idx = int(d.get("index", 0) or 0)
            slot = self.by_index.setdefault(
                idx, {"id": "", "name": "", "arguments": ""}
            )
            if (cid := d.get("id")):
                slot["id"] = cid
            if (name := d.get("name")):
                slot["name"] += name
            if (args := d.get("arguments_delta")):
                slot["arguments"] += args

    def finalize(self) -> list[dict[str, Any]]:
        return [self.by_index[i] for i in sorted(self.by_index)]


async def _dispatch_tool_call(
    *,
    name: str,
    arguments_json: str,
    tools: dict[str, ToolFn],
    request_id: str | None,
    yield_event: "Callable[[str, dict[str, Any]], None] | None" = None,
) -> Any:
    """Resolve the tool by name and call it with parsed args. Errors
    are returned as `{error: "..."}` dicts so the LLM can react in
    its next turn (e.g. correct a malformed verse address).

    Tools registered with `emits_events=True` (track_pdf_generate,
    track_pdf_generate, track_outline_get, reminder_propose, etc.)
    accept a `yield_event(type, data)` callback as a kwarg —
    that's how they push the matching `action` SSE event to the
    client. Without injection here the LLM gets the `action_id`
    back, embeds `[action:share_pdf|id=…]` in prose, but the
    client never receives the action payload and renders a broken
    card. We pull the `EMITS_EVENTS` set lazily to avoid a circular
    import (`agent.tools.__init__` imports build_personalized_tools
    which transitively touches a domain port).
    """
    # Lazy import — see docstring.
    from shruti_chat.agent.tools import EMITS_EVENTS

    fn = tools.get(name)
    if fn is None:
        return {"error": f"unknown tool {name!r}"}
    try:
        args = json.loads(arguments_json or "{}")
    except json.JSONDecodeError as exc:
        return {"error": f"bad JSON in tool args: {exc}"}
    if name in EMITS_EVENTS and yield_event is not None:
        args["yield_event"] = yield_event
    # Lazy import to avoid circular dep on agent boot path.
    from shruti_chat.observability.langfuse_client import get_langfuse

    langfuse = get_langfuse()
    # Strip the yield_event callback from the langfuse input — it's an
    # unserialisable closure and not a real tool argument, just a side-
    # channel we inject for tools that emit SSE events.
    langfuse_input = {k: v for k, v in args.items() if k != "yield_event"}

    t0 = time.monotonic()
    try:
        if langfuse is not None:
            with langfuse.start_as_current_observation(
                as_type="tool",
                name=name,
                input=langfuse_input,
            ) as tool_span:
                try:
                    result = await fn(**args)
                except TypeError as exc:
                    result = {"error": f"bad args: {exc}"}
                except Exception as exc:
                    log.exception("tool_call_failed", request_id=request_id, tool=name, error=str(exc))
                    result = {"error": str(exc)}
                try:
                    tool_span.update(output=result)
                except Exception:  # noqa: BLE001
                    pass
        else:
            try:
                result = await fn(**args)
            except TypeError as exc:
                result = {"error": f"bad args: {exc}"}
            except Exception as exc:
                log.exception("tool_call_failed", request_id=request_id, tool=name, error=str(exc))
                result = {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        # Defensive: if the observation context itself blows up
        # (e.g. Langfuse transport error mid-dispatch), don't break the
        # turn — run the tool without instrumentation as a fallback.
        log.warning("langfuse_tool_span_failed", tool=name, error=str(exc))
        try:
            result = await fn(**args)
        except Exception as inner:  # noqa: BLE001
            log.exception("tool_call_failed", request_id=request_id, tool=name, error=str(inner))
            result = {"error": str(inner)}

    # agent_role is picked up from the contextvar bound by the node
    # via `bind_node_role(...)` — research/catalog/action/help all call
    # this same use-case but the log line must reflect the actual node.
    log.info(
        "tool_call",
        request_id=request_id,
        tool_name=name,
        duration_ms=int((time.monotonic() - t0) * 1000),
    )
    return result


def _extracted_args_block(extracted_args: dict[str, Any]) -> str:
    """Format the router's seed args as a short instruction block."""
    if not extracted_args:
        return ""
    items = [f"- {k}: {v!r}" for k, v in extracted_args.items() if v not in (None, "")]
    if not items:
        return ""
    return (
        "\n\n"
        "Router extracted these seed args from the user's query. Use them\n"
        "as starting hints (not hard filters — broaden if the seed gives\n"
        "no results):\n"
        + "\n".join(items)
        + "\n"
    )


async def run_react_loop(
    user_query: str,
    *,
    extracted_args: dict[str, Any],
    llm: _LLMForResearch,
    tools: dict[str, ToolFn],
    tool_schemas: list[dict[str, Any]],
    # The alias map is consumed at tool-wrap time (build_aliased_tools).
    # We keep `aliases` on the signature as a hand-off marker for the
    # caller — even though the loop never touches it — so future
    # changes (e.g. logging minted refs per turn) don't need a signature
    # bump and so the contract documents "this fn assumes pre-aliased
    # tools that mint into THIS map".
    aliases: TurnAliasMap,
    system_prompt: str,
    request_id: str | None = None,
    model: str | None = None,
    max_turns: int = DEFAULT_MAX_TURNS,
    on_tool_event: ToolLifecycleCallback | None = None,
    yield_event: YieldEventCallback | None = None,
    # Langfuse `CallbackHandler` instances threaded into every LLM call
    # in this loop, so each ReAct iteration shows up as a span under
    # the per-turn root trace. `None` = no observability (off-path or
    # `LANGFUSE_FORCE_FALLBACK=1`).
    callbacks: list[Any] | None = None,
    # Logical worker name ("research_worker", "catalog_worker", etc.) —
    # propagated to the LLM-call span name so the Langfuse trace tree
    # labels each ReAct iteration with its node + turn instead of
    # generic "ChatOpenAI". Caller is the per-worker wrapper.
    run_name: str | None = None,
) -> ResearchResult:
    """Run the multi-step research ReAct loop and return tool results.

    `tools` MUST already be aliased (i.e. wrapped via
    `build_aliased_tools` so they mint into `aliases` and dealias
    integer ref inputs). `system_prompt` is built from a section subset
    appropriate for the research worker — typically
    `header + tools + quoting`.
    """
    seed_args = _extracted_args_block(extracted_args)
    messages: list[Message] = [
        {"role": "system", "content": system_prompt + seed_args},
        {"role": "user", "content": user_query},
    ]
    result = ResearchResult()

    # On turn 0 we want the LLM to MUST pick a tool. With multiple
    # tools "required" works on most providers, but Gemini Flash Lite
    # via OpenRouter has been observed ignoring "required" when only
    # ONE tool is available (it answers from training data instead).
    # In that case, pass the tool's literal name — providers honor
    # that consistently.
    initial_tool_choice: str = (
        next(iter(tools)) if len(tools) == 1 else "required"
    )

    for turn in range(max_turns):
        result.n_turns = turn + 1
        acc = _ToolCallAccumulator()
        finish_reason: str | None = None

        async for chunk in llm.stream_completion(
            messages,
            tools=tool_schemas,
            tool_choice=initial_tool_choice if turn == 0 else None,
            model=model,
            temperature=0.2,
            callbacks=callbacks,
            run_name=(
                f"{run_name}_turn{turn + 1}" if run_name
                else f"react_turn{turn + 1}"
            ),
        ):
            acc.consume(chunk.get("tool_calls"))
            if (fr := chunk.get("finish_reason")):
                finish_reason = fr

        tool_calls = acc.finalize()
        if not tool_calls:
            # LLM produced no tool calls — research converged. The
            # synthesizer takes it from here.
            log.info(
                "research_converged",
                request_id=request_id,
                turn=turn + 1,
                results=len(result.tool_results),
                finish_reason=finish_reason,
            )
            return result

        # Append the assistant tool-call turn. Content stays empty —
        # any prose the LLM streamed between tool calls is intentionally
        # dropped (workers don't stream to client, see plan section 5).
        # Use langchain's flat tool_call shape (id/name/args), not the
        # OpenAI raw {type:function, function:{...}} envelope. The
        # adapter in OpenRouterLLMProvider._to_langchain_message hands
        # this dict straight to AIMessage(tool_calls=...).
        parsed_tool_calls: list[dict[str, Any]] = []
        for tc in tool_calls:
            try:
                args = json.loads(tc["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            parsed_tool_calls.append(
                {"id": tc["id"], "name": tc["name"], "args": args}
            )
        messages.append(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": parsed_tool_calls,
            }
        )

        for tc in tool_calls:
            if on_tool_event is not None:
                on_tool_event("tool_start", tc["name"])
            tool_result = await _dispatch_tool_call(
                name=tc["name"],
                arguments_json=tc["arguments"],
                tools=tools,
                request_id=request_id,
                yield_event=yield_event,
            )
            if on_tool_event is not None:
                on_tool_event("tool_end", tc["name"])
            result.tool_results.append(tool_result)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": json.dumps(tool_result, ensure_ascii=False, default=str),
                }
            )

    log.warning(
        "research_hit_max_turns",
        request_id=request_id,
        max_turns=max_turns,
        results=len(result.tool_results),
    )
    result.hit_max_turns = True
    return result
