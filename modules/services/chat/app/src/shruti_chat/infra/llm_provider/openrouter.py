"""OpenRouter adapter for `LLMPort`.

OpenRouter exposes an OpenAI-compatible API at `https://openrouter.ai/api/v1`,
so we point `langchain_openai.ChatOpenAI` at it via `base_url` and let the
provider route by model prefix (`google/gemini-3.1-flash-lite`,
`anthropic/claude-3-haiku`, ...).

Why ChatOpenAI specifically: it streams reliably through OpenRouter
via the OpenAI-compatible base_url, handles `tool_choice` (including
the literal-tool-name form we use on single-tool worker menus, see
`research_turn.run_research_turn`), and gives us `with_structured_output`
for the router's JSON-mode classification. Tested against
google/gemini-3.1-flash-lite (default) and Claude (premium tier).
"""

from __future__ import annotations

from typing import Any, AsyncIterator, TypeVar

from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_openai import ChatOpenAI
from pydantic import BaseModel

from shruti_chat.config import Settings
from shruti_chat.domain.entities import CompletionChunk, Message, ToolCallDelta
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)

T = TypeVar("T", bound=BaseModel)


# OpenRouter speaks OpenAI's chat-completions wire format verbatim.
_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Legacy settings use LiteLLM-shaped model ids like
# `openrouter/google/gemini-3.1-flash-lite`. OpenRouter's native API
# expects just `google/gemini-3.1-flash-lite` — strip the prefix when
# we wire langchain_openai directly (no LiteLLM in the loop).
_LITELLM_PREFIX = "openrouter/"


def _normalise_model(model: str) -> str:
    if model.startswith(_LITELLM_PREFIX):
        return model[len(_LITELLM_PREFIX):]
    return model


def _to_langchain_message(m: Message) -> BaseMessage:
    """Domain Message → LangChain BaseMessage. Boundary conversion: we
    keep Message in domain (so application doesn't import langchain),
    convert here at the adapter edge."""
    role = m["role"]
    content = m["content"]
    if role == "system":
        return SystemMessage(content=content)
    if role == "user":
        return HumanMessage(content=content)
    if role == "assistant":
        tool_calls = m.get("tool_calls") or []
        return AIMessage(content=content, tool_calls=tool_calls)  # type: ignore[arg-type]
    if role == "tool":
        return ToolMessage(content=content, tool_call_id=m.get("tool_call_id", ""))
    raise ValueError(f"unknown message role: {role!r}")


def _chunk_to_domain(chunk: AIMessageChunk) -> CompletionChunk:
    """LangChain stream chunk → domain CompletionChunk. Strips LangChain
    types so callers stay clean."""
    out: CompletionChunk = {}
    if isinstance(chunk.content, str) and chunk.content:
        out["text"] = chunk.content
    # tool_call_chunks is the streaming-friendly form (deltas, not full calls).
    tc_chunks = getattr(chunk, "tool_call_chunks", None) or []
    if tc_chunks:
        deltas: list[ToolCallDelta] = []
        for tc in tc_chunks:
            d: ToolCallDelta = {}
            if (idx := tc.get("index")) is not None:
                d["index"] = idx
            if (cid := tc.get("id")):
                d["id"] = cid
            if (name := tc.get("name")):
                d["name"] = name
            if (args := tc.get("args")):
                d["arguments_delta"] = args
            if d:
                deltas.append(d)
        if deltas:
            out["tool_calls"] = deltas
    if (finish := chunk.response_metadata.get("finish_reason")):
        out["finish_reason"] = finish
    usage = chunk.usage_metadata
    if usage is not None:
        if (pt := usage.get("input_tokens")) is not None:
            out["prompt_tokens"] = pt
        if (ct := usage.get("output_tokens")) is not None:
            out["completion_tokens"] = ct
    return out


class OpenRouterLLMProvider:
    """`LLMPort` impl backed by `langchain_openai.ChatOpenAI` → OpenRouter.

    One instance per request (cheap to construct). The underlying
    `ChatOpenAI` client is recreated when `model` overrides at call time
    — small overhead but keeps the API simple. If we hit perf trouble,
    swap to a small LRU cache of ChatOpenAI by (model, temperature).
    """

    def __init__(self, settings: Settings) -> None:
        if not settings.openrouter_api_key:
            raise RuntimeError(
                "OpenRouterLLMProvider requires OPENROUTER_API_KEY in settings"
            )
        self._api_key = settings.openrouter_api_key
        self._default_model = settings.llm_default
        # Pre-build the default-model client. Per-call overrides create
        # a transient client (see _client_for).
        self._default_client = self._client_for(self._default_model, temperature=None)

    def _client_for(self, model: str, *, temperature: float | None) -> ChatOpenAI:
        kwargs: dict[str, Any] = {
            "model": _normalise_model(model),
            "base_url": _OPENROUTER_BASE_URL,
            "api_key": self._api_key,
            "streaming": True,
        }
        if temperature is not None:
            kwargs["temperature"] = temperature
        return ChatOpenAI(**kwargs)

    async def stream_completion(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
    ) -> AsyncIterator[CompletionChunk]:
        client = self._client_for(model or self._default_model, temperature=temperature)
        if tools:
            # langchain_openai accepts tool_choice as:
            #   "auto" | "required" | "none" | None  – generic modes
            #   "<tool_name>"                        – force specific tool
            #   {"type": "function", "function": {...}} – dict form
            # We pass the string through verbatim (the loop in
            # research_turn already picks a valid value: a generic mode
            # OR a known tool name). Reject obviously malformed values
            # to avoid noisy provider errors.
            _allowed_generic = ("auto", "required", "none")
            chosen: Any
            if tool_choice in _allowed_generic or tool_choice is None:
                chosen = tool_choice
            elif isinstance(tool_choice, str):
                chosen = tool_choice  # tool name
            else:
                chosen = None
            client = client.bind_tools(  # type: ignore[assignment]
                tools=tools,
                tool_choice=chosen,
            )
        lc_msgs = [_to_langchain_message(m) for m in messages]
        async for chunk in client.astream(lc_msgs):
            # ChatOpenAI emits AIMessageChunk; type-narrow defensively in
            # case provider returns something else (Anthropic via OpenRouter
            # has occasionally returned bare AIMessage on tool calls).
            if isinstance(chunk, AIMessageChunk):
                domain_chunk = _chunk_to_domain(chunk)
                if domain_chunk:
                    yield domain_chunk

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
    ) -> T:
        client = self._client_for(model or self._default_model, temperature=0)
        structured = client.with_structured_output(schema)
        lc_msgs = [_to_langchain_message(m) for m in messages]
        result = await structured.ainvoke(lc_msgs)
        # `with_structured_output` returns the schema instance directly
        # when method="function_calling" (the default). Type-cast here
        # for callers' benefit.
        if not isinstance(result, schema):
            raise RuntimeError(
                f"structured_output: provider returned {type(result).__name__}, "
                f"expected {schema.__name__}"
            )
        return result
