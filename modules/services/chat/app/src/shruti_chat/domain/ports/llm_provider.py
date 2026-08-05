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
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
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
        - `callbacks`: LangChain `BaseCallbackHandler` list, threaded
          into the underlying `ChatOpenAI(callbacks=...)`. Used to
          attach a Langfuse `CallbackHandler` so the LLM call appears
          as a span under the per-turn Langfuse trace. `None` =
          un-instrumented call (no observability overhead).
        """
        ...

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T:
        """One-shot call returning a validated Pydantic instance.

        Uses the provider's JSON-mode (OpenAI's `response_format`,
        Anthropic's tool-use, etc.). Adapters MUST validate against the
        schema before returning — callers should never see a parsing
        error past this method.

        `callbacks` is forwarded to the underlying `ChatOpenAI` so the
        call shows up as a span under the active Langfuse trace.
        Temperature for `structured_output` is forced to 0 inside the
        adapter — see `infra/llm_provider/openrouter.py` for the
        rationale; configured `temperature` values from Langfuse
        prompt-config are intentionally ignored here.
        """
        ...

    async def text_completion(
        self,
        messages: list[Message],
        *,
        model: str | None = None,
        run_name: str | None = None,
    ) -> str:
        """One-shot completion returning plain text — for callers whose
        whole payload is a single prose string (a search-card blurb, an
        intro/conclusion line).

        Prefer this over `structured_output` with a one-field wrapper
        schema: asking a (cheap) model for a `{"field": "…"}` envelope
        around one sentence buys nothing and, on weak models, fails to
        parse — costing a retry, the fallback model, and latency for output
        that was never structured. Temperature is forced to 0 in the
        adapter, same as `structured_output`. An empty string is a valid
        result ("nothing to add").
        """
        ...

    # NB: an earlier draft of the port exposed `as_chat_model() ->
    # BaseChatModel` as an escape hatch for LangGraph's
    # `create_react_agent`. We don't use create_react_agent (we run
    # our own ReAct loop in `application/react_loop.py` so we can
    # inject `yield_event` into emits_events tools), so the method
    # has no callers and is intentionally NOT on the Protocol.
    # If a future feature needs the underlying LangChain model, add
    # it back here AND keep its only call site inside `agent/graph/`.


class ProviderUnavailable(Exception):
    """The provider could not service the call — out of credits, key rejected,
    rate limited, model down — after retries AND the fallback model were spent.

    Mirrors `RateLimitStoreUnavailable` in `rate_limit_store.py`: the adapter
    knows the vendor's status codes, callers only need "the provider is down,
    tell the user to retry" versus "our graph is broken". Before this,
    `application/` and `research/` imported a predicate out of the OpenRouter
    adapter to make that distinction — a use case reaching into a named vendor
    to pick an error code.
    """


def provider_unavailable(exc: BaseException) -> bool:
    """True if `exc` or anything in its cause/context chain is a
    `ProviderUnavailable`.

    Walks the chain because LangGraph re-raises node exceptions wrapped in its
    own frames, so the original is rarely the outermost object a caller
    catches.
    """
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, ProviderUnavailable):
            return True
        cur = cur.__cause__ or cur.__context__
    return False
