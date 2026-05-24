"""OpenRouter adapter for `LLMPort`.

OpenRouter exposes an OpenAI-compatible API at `https://openrouter.ai/api/v1`,
so we point `langchain_openai.ChatOpenAI` at it via `base_url` and let the
provider route by model prefix (`google/gemini-3.1-flash-lite`,
`anthropic/claude-3-haiku`, ...).

Why ChatOpenAI specifically: it streams reliably through OpenRouter
via the OpenAI-compatible base_url, handles `tool_choice` (including
the literal-tool-name form we use on single-tool worker menus, see
`react_loop.run_react_loop`), and gives us `with_structured_output`
for the router's JSON-mode classification. Tested against
google/gemini-3.1-flash-lite (default) and Claude (premium tier).
"""

from __future__ import annotations

from contextlib import nullcontext
from functools import lru_cache
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
from shruti_chat.observability.langfuse_client import get_langfuse
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


def _build_model_allowlist(settings: Settings) -> frozenset[str]:
    """Models the adapter will pass through to ChatOpenAI verbatim.

    Built from `Settings.llm_*` plus an explicit allow set of known-good
    OpenRouter ids. Guards against typos in Langfuse prompt-config
    (`{"model": "gemnini-3.1-flash"}` would otherwise reach OpenRouter
    and 400). On miss we log a warning and fall back to `llm_default`.
    """
    base = {
        settings.llm_default,
        settings.llm_fallback,
        settings.llm_premium,
        settings.llm_outline,
        settings.llm_query_expander,
        # Known-good aliases — extend here when adding a new model to
        # Langfuse prompt-config. Keep curated; the whole point is
        # rejecting typos before they hit the provider.
        "openrouter/anthropic/claude-3.5-sonnet",
        "openrouter/anthropic/claude-3-haiku",
        "openrouter/google/gemini-2.0-flash-001",
        "openrouter/google/gemini-3.1-flash-lite",
        "openrouter/deepseek/deepseek-chat",
    }
    # Store both the LiteLLM-prefixed and the normalised forms so the
    # check is robust regardless of which shape the caller provides.
    expanded: set[str] = set()
    for m in base:
        if not m:
            continue
        expanded.add(m)
        expanded.add(_normalise_model(m))
    return frozenset(expanded)


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


@lru_cache(maxsize=32)
def _build_client(
    api_key: str,
    model: str,
    temperature_key: float | None,
    streaming: bool = True,
) -> ChatOpenAI:
    """Module-level LRU cache of `ChatOpenAI` by (model, temperature, streaming).

    Each `ChatOpenAI` owns an httpx client with a persistent connection
    pool — recreating it per call meant a fresh TLS handshake on every
    LLM hop (50-150 ms × ~5-8 calls per research turn = up to a second
    of pure connection overhead). The instance is async-safe and stateless
    apart from its conn pool, so sharing is trivially correct.

    `streaming=False` is used for `structured_output()` calls — when the
    OpenAI-compatible provider streams, `AIMessage.usage_metadata` is
    None on the final aggregated message (tokens only land per-chunk on
    `AIMessageChunk` during the stream, which `with_structured_output`
    discards). Non-streaming gives us a complete AIMessage with
    `usage_metadata` populated, which we feed to Langfuse.
    """
    kwargs: dict[str, Any] = {
        "model": _normalise_model(model),
        "base_url": _OPENROUTER_BASE_URL,
        "api_key": api_key,
        "streaming": streaming,
        # Hard cap so a vendor stall doesn't hold a DB transaction
        # (and a Postgres connection) open indefinitely. 180s covers
        # the slowest legitimate chat turn we've observed (claude-3.7
        # on a long research pass) with a safety margin; without it
        # langchain-openai defaults to 600s, which is long enough for
        # the connection pool to bleed.
        "timeout": 180.0,
    }
    if temperature_key is not None:
        kwargs["temperature"] = temperature_key
    return ChatOpenAI(**kwargs)


class OpenRouterLLMProvider:
    """`LLMPort` impl backed by `langchain_openai.ChatOpenAI` → OpenRouter.

    Clients are pooled by `(model, temperature)` in a module-level LRU
    so the underlying httpx connection pool survives across calls.

    Per-call `callbacks` (e.g. a Langfuse `CallbackHandler`) are NOT
    cached with the client — they bind a fresh `ChatOpenAI` via
    `bind(callbacks=...)` at call time so each turn gets its own trace
    binding while the underlying httpx pool stays shared.
    """

    def __init__(self, settings: Settings) -> None:
        if not settings.openrouter_api_key:
            raise RuntimeError(
                "OpenRouterLLMProvider requires OPENROUTER_API_KEY in settings"
            )
        self._api_key = settings.openrouter_api_key
        self._default_model = settings.llm_default
        self._allowlist = _build_model_allowlist(settings)
        # Pre-warm the default-model client so the first turn doesn't
        # pay the construction cost on the request path.
        _build_client(self._api_key, self._default_model, None)

    def _validate_model(self, model: str | None) -> str:
        """Whitelist gate. Unknown models fall back to `llm_default` with
        a warning so a typo in Langfuse prompt-config doesn't 400 the
        provider call."""
        if model is None:
            return self._default_model
        if model in self._allowlist or _normalise_model(model) in self._allowlist:
            return model
        log.warning(
            "llm_model_not_in_allowlist_fallback",
            requested_model=model,
            fallback_model=self._default_model,
        )
        return self._default_model

    def _client_for(
        self,
        model: str,
        *,
        temperature: float | None,
        streaming: bool = True,
    ) -> ChatOpenAI:
        return _build_client(self._api_key, model, temperature, streaming)

    @staticmethod
    def _generation_ctx(
        *,
        name: str | None,
        model: str,
        messages: list[Message],
        model_parameters: dict[str, Any] | None,
    ) -> Any:
        """Open a Langfuse `generation` observation around one LLM call.

        We register every LLM call as a typed `generation` (NOT a plain
        `span`) so the UI gets:
          - model attribute → Langfuse pricing lookup → real cost
          - usage_details (set on `.update()` after the call completes)
          - input/output rendered in the dedicated panes, not metadata

        Why not the LangChain CallbackHandler: in our stack (LangGraph +
        OpenRouter, LLM lives inside a LangGraph node wrapped runnable),
        the handler's `on_chat_model_start` is unreliable — calls land
        as `type=span` not `type=generation` (langfuse issue #8025, by
        design for non-canonical chains). Wrapping here at the only two
        actual LLM call sites is exact and complete.

        Returns the SDK's own context manager when a singleton exists,
        otherwise a `nullcontext(None)` so the call site stays branch-
        free. The caller MUST do `if gen is not None: gen.update(...)`.
        """
        lf = get_langfuse()
        if lf is None:
            return nullcontext(None)
        try:
            return lf.start_as_current_observation(
                as_type="generation",
                name=name or "llm_call",
                model=model,
                input=messages,
                model_parameters=model_parameters or None,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("langfuse_generation_open_failed", error=str(exc))
            return nullcontext(None)

    async def stream_completion(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        # Legacy param: callers may still pass a list. We no longer
        # propagate it to LangChain — the Langfuse CallbackHandler
        # was producing `type=span` (not `generation`) and unnamed
        # nested children. Manual `generation` wrap below replaces it.
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> AsyncIterator[CompletionChunk]:
        validated_model = self._validate_model(model)
        client = self._client_for(validated_model, temperature=temperature)
        if tools:
            # langchain_openai accepts tool_choice as:
            #   "auto" | "required" | "none" | None  – generic modes
            #   "<tool_name>"                        – force specific tool
            #   {"type": "function", "function": {...}} – dict form
            # We pass the string through verbatim (the loop in
            # react_loop already picks a valid value: a generic mode
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
        gen_ctx = self._generation_ctx(
            name=run_name,
            model=validated_model,
            messages=messages,
            model_parameters=(
                {"temperature": temperature} if temperature is not None else None
            ),
        )
        # Accumulate text + token totals locally; the generation needs
        # to know the FULL output, not per-chunk deltas, plus final
        # usage counts (OpenRouter sends usage_metadata in the last
        # chunk only, mirroring OpenAI's stream protocol).
        text_acc: list[str] = []
        tool_call_acc: list[dict[str, Any]] = []
        usage_in = 0
        usage_out = 0
        with gen_ctx as gen:
            try:
                async for chunk in client.astream(lc_msgs):
                    # ChatOpenAI emits AIMessageChunk; type-narrow
                    # defensively — Anthropic via OpenRouter has been
                    # observed returning bare AIMessage on tool calls.
                    if not isinstance(chunk, AIMessageChunk):
                        continue
                    domain_chunk = _chunk_to_domain(chunk)
                    if not domain_chunk:
                        continue
                    if (t := domain_chunk.get("text")):
                        text_acc.append(t)
                    if (tc := domain_chunk.get("tool_calls")):
                        tool_call_acc.extend(tc)
                    if (pt := domain_chunk.get("prompt_tokens")) is not None:
                        usage_in = pt
                    if (ct := domain_chunk.get("completion_tokens")) is not None:
                        usage_out = ct
                    yield domain_chunk
            finally:
                if gen is not None:
                    try:
                        gen_output: dict[str, Any] = {"text": "".join(text_acc)}
                        if tool_call_acc:
                            gen_output["tool_calls"] = tool_call_acc
                        gen.update(
                            output=gen_output,
                            usage_details={"input": usage_in, "output": usage_out},
                        )
                    except Exception as exc:  # noqa: BLE001
                        log.warning("langfuse_generation_update_failed", error=str(exc))

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        # See `stream_completion`: legacy param, no longer threaded.
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T:
        # temperature is forced to 0 for structured_output regardless of
        # what a Langfuse prompt-config carries. Routing / topic
        # extraction / query expansion all rely on deterministic JSON
        # output; non-zero temperature flaps the parser. The bootstrap
        # script for Langfuse documents this explicitly so prompt
        # editors don't expect temperature changes to take effect for
        # structured_output prompts.
        validated_model = self._validate_model(model)
        # `streaming=False`: see `_build_client` docstring — streaming
        # clients drop `usage_metadata` from the final AIMessage, which
        # we need to feed Langfuse generation tokens. Structured output
        # is one-shot anyway; no value lost by not streaming.
        client = self._client_for(validated_model, temperature=0, streaming=False)
        # `include_raw=True` so we can read `usage_metadata` off the
        # underlying AIMessage and feed it to the Langfuse generation.
        # Without it `with_structured_output` returns the parsed Pydantic
        # instance only — we lose tokens / model attribution.
        structured = client.with_structured_output(schema, include_raw=True)
        lc_msgs = [_to_langchain_message(m) for m in messages]
        gen_ctx = self._generation_ctx(
            name=run_name,
            model=validated_model,
            messages=messages,
            model_parameters={"temperature": 0},
        )
        with gen_ctx as gen:
            raw_and_parsed: Any = await structured.ainvoke(lc_msgs)
            parsed = raw_and_parsed.get("parsed") if isinstance(raw_and_parsed, dict) else raw_and_parsed
            if not isinstance(parsed, schema):
                raise RuntimeError(
                    f"structured_output: provider returned {type(parsed).__name__}, "
                    f"expected {schema.__name__}"
                )
            if gen is not None:
                try:
                    usage_in = 0
                    usage_out = 0
                    raw_msg = (
                        raw_and_parsed.get("raw")
                        if isinstance(raw_and_parsed, dict)
                        else None
                    )
                    if raw_msg is not None:
                        usage_meta = getattr(raw_msg, "usage_metadata", None) or {}
                        usage_in = usage_meta.get("input_tokens") or 0
                        usage_out = usage_meta.get("output_tokens") or 0
                    gen.update(
                        output=parsed.model_dump(),
                        usage_details={"input": usage_in, "output": usage_out},
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning("langfuse_generation_update_failed", error=str(exc))
            return parsed
