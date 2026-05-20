"""LLMPort — provider-agnostic LLM access.

Two surfaces:

- `stream_completion` — token + tool-call streaming. Used by synthesizer
  to emit deltas through `MarkerExpander` to the client.
- `structured_output` — one-shot call that returns a Pydantic-validated
  object. Used by router_node to get `RoutingDecision` from the model
  in JSON-mode.

LangGraph's `create_react_agent` consumes a `BaseChatModel` directly,
not our `LLMPort`. To bridge that, the port exposes `as_chat_model()` as
a documented escape hatch — call it ONLY from inside `agent/graph/nodes/`
where LangChain types are allowed to leak. Application use-cases stay
clean by using `stream_completion` / `structured_output` instead.

Implementations live in `infra/llm_provider/*`. Tests use a `FakeLLM`
that scripts the responses.
"""

from __future__ import annotations

from typing import Any, AsyncIterator, Protocol, TypeVar, runtime_checkable

from pydantic import BaseModel

from shruti_chat.domain.entities import CompletionChunk, Message


T = TypeVar("T", bound=BaseModel)


@runtime_checkable
class LLMPort(Protocol):
    """Abstraction over the underlying LLM provider (LiteLLM, langchain-openai, ...)."""

    async def stream_completion(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
    ) -> AsyncIterator[CompletionChunk]:
        """Stream chunks of an LLM completion.

        - `tools`: OpenAI function-calling schemas. Pass to enable
          tool use; omit for pure text generation.
        - `tool_choice`: `"required"` forces a tool call on the next
          turn; `"auto"` lets the model decide; `None` = provider default.
        - `model`: override the provider's default. Useful for per-node
          model tiering (e.g. router on Haiku, synth on Sonnet).
        - `temperature`: 0 for deterministic output (router classification),
          higher for prose generation (synth).
        """
        ...

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
    ) -> T:
        """One-shot call returning a validated Pydantic instance.

        Uses the provider's JSON-mode (OpenAI's `response_format`,
        Anthropic's tool-use, etc.). Adapters MUST validate against the
        schema before returning — callers should never see a parsing
        error past this method.
        """
        ...

    # NB: an earlier draft of the port exposed `as_chat_model() ->
    # BaseChatModel` as an escape hatch for LangGraph's
    # `create_react_agent`. We don't use create_react_agent (we run
    # our own ReAct loop in `application/research_turn.py` so we can
    # inject `yield_event` into emits_events tools), so the method
    # has no callers and is intentionally NOT on the Protocol.
    # If a future feature needs the underlying LangChain model, add
    # it back here AND keep its only call site inside `agent/graph/`.
