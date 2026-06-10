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

import asyncio
import random
from contextlib import nullcontext
from functools import lru_cache
from typing import Any, AsyncIterator, TypeVar

import openai
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


# Transient provider errors worth retrying / escalating to the fallback
# model. The openai SDK (which langchain_openai wraps) raises these for
# timeouts, rate limits, 5xx, and connection drops. A BadRequestError /
# AuthenticationError is NOT here — those fail identically on a retry, so
# we surface them immediately rather than burning the retry budget.
_RETRYABLE_EXC = (
    openai.APIConnectionError,
    openai.APITimeoutError,
    openai.RateLimitError,
    openai.InternalServerError,
)


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, _RETRYABLE_EXC):
        return True
    # Some providers surface 429/5xx as a generic APIStatusError.
    status = getattr(exc, "status_code", None)
    return isinstance(status, int) and (status == 429 or 500 <= status < 600)


# Provider-availability failures: by the time one of these escapes
# `stream_completion` the retries AND the fallback model are already
# exhausted, so the backend genuinely can't get a completion from anyone
# right now. Causes: out of credits (402), the OpenRouter key being
# rejected (401/403), the provider rate-limiting us (429), a request
# timeout (408), or a 5xx / dropped connection. None of these are the
# user's fault or a bug in our graph, so the turn should surface a calm
# "chat temporarily unavailable" instead of a generic agent error.
_UNAVAILABLE_EXC = (
    openai.APIConnectionError,
    openai.APITimeoutError,
    openai.RateLimitError,
    openai.InternalServerError,
    openai.AuthenticationError,
    openai.PermissionDeniedError,
)
_UNAVAILABLE_STATUS = frozenset({401, 402, 403, 408, 429})


def is_provider_unavailable(exc: BaseException) -> bool:
    """True if `exc` — or anything in its `__cause__` / `__context__`
    chain — is an LLM-provider-availability failure.

    Walks the chain because LangGraph re-raises node exceptions wrapped in
    its own frames, so the original `openai.APIStatusError` is rarely the
    outermost object the caller catches. A 400 (BadRequest, our bug) and a
    404 (unknown model) are deliberately NOT here — they fail identically
    on retry and mean something is wrong on our side, so they stay
    `agent_error`."""
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, _UNAVAILABLE_EXC):
            return True
        status = getattr(cur, "status_code", None)
        if isinstance(status, int) and (
            status in _UNAVAILABLE_STATUS or 500 <= status < 600
        ):
            return True
        cur = cur.__cause__ or cur.__context__
    return False


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
        settings.llm_outline,
        settings.llm_query_planner,
        settings.llm_synthesis_planner,
        settings.llm_conclusion_writer,
        # Curated known-good ids. This is now a HINT, not a gate: a model
        # outside this set is still used (with a loud warning) so changing a
        # model in Langfuse prompt-config doesn't need a code deploy. Listing
        # a vetted model here just silences the warning. See `_validate_model`.
        "openrouter/anthropic/claude-3-haiku",
        "openrouter/google/gemini-2.0-flash-001",
        "openrouter/google/gemini-2.5-flash",
        "openrouter/google/gemini-3.1-flash-lite",
        "openrouter/google/gemini-3.5-flash",
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
        # Cached-prefix hits land in input_token_details.cache_read
        # (langchain maps OpenRouter's prompt_tokens_details.cached_tokens
        # here). Surface it so we can see implicit-cache hits.
        if (cr := (usage.get("input_token_details") or {}).get("cache_read")) is not None:
            out["cached_tokens"] = cr
    return out


def _usage_details(input_tokens: int, output_tokens: int, cached_tokens: int) -> dict[str, int]:
    """Langfuse `usage_details` payload. On a prompt-cache hit, split the
    prompt tokens into the uncached `input` and a `cache_read` bucket so
    the rollup total (input+output) is unchanged while the cache hit is
    visible. No hit → identical shape to the old `{input, output}`."""
    if cached_tokens > 0:
        return {
            "input": max(0, input_tokens - cached_tokens),
            "cache_read": cached_tokens,
            "output": output_tokens,
        }
    return {"input": input_tokens, "output": output_tokens}


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
    if not streaming:
        # Structured-output calls only (streaming=False). Without an explicit
        # cap the provider's default completion budget can be shorter than a
        # full Outline (intro + up to 5 theses + conclusion), which truncates
        # the JSON mid-object and surfaces as `ValidationError: Invalid JSON:
        # EOF` — the planner then degrades to free-form synthesis with no
        # intro/conclusion/headers. 4096 comfortably fits the largest outline
        # and sits at-or-below every structured model's own cap (gemini-flash,
        # deepseek-chat, claude-3-haiku), so it never trips a 400. The
        # streaming synthesizer is deliberately left uncapped so long answers
        # are never clipped.
        kwargs["max_tokens"] = 4096
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
        self._fallback_model = settings.llm_fallback
        self._max_retries = max(0, settings.llm_max_retries)
        self._retry_base_s = settings.llm_retry_base_delay_s
        self._allowlist = _build_model_allowlist(settings)
        # Pre-warm the default-model client so the first turn doesn't
        # pay the construction cost on the request path.
        _build_client(self._api_key, self._default_model, None)

    def _fallback_for(self, primary_model: str) -> str | None:
        """The escalation model for `primary_model`, or None when no
        distinct fallback is configured (don't re-try the same model as
        its own fallback)."""
        fb = self._fallback_model
        if not fb or _normalise_model(fb) == _normalise_model(primary_model):
            return None
        return fb

    def _backoff_delay(self, attempt: int) -> float:
        """Exponential backoff with full jitter: base·2^attempt, then a
        uniform [0, that] draw so concurrent turns don't retry in lockstep."""
        ceiling = self._retry_base_s * (2 ** attempt)
        return random.uniform(0, ceiling)

    def _validate_model(self, model: str | None) -> str:
        """Resolve the model to use. The curated allowlist is a HINT, not a
        gate: an unrecognized model is used anyway with a loud warning, so a
        model change in Langfuse prompt-config takes effect WITHOUT a code
        deploy. The warning still flags a likely typo (which then fails fast
        at the provider with a clear 404 rather than silently degrading to a
        different model)."""
        if model is None:
            return self._default_model
        if model in self._allowlist or _normalise_model(model) in self._allowlist:
            return model
        log.warning(
            "llm_model_not_in_allowlist_using_anyway",
            requested_model=model,
        )
        return model

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
        """Stream a completion with transient-retry + model-fallback.

        Resilience is bounded by a hard streaming constraint: once the
        first chunk has been yielded to the consumer it is already on the
        wire, so a mid-stream failure CANNOT be re-rolled onto another
        attempt (that would duplicate/corrupt the client's output). All
        retries + the fallback escalation therefore only fire while
        nothing has been produced yet; a failure after first output is
        re-raised verbatim.
        """
        validated_model = self._validate_model(model)
        fallback_model = self._fallback_for(validated_model)
        produced = False
        last_exc: BaseException | None = None

        # Primary model: initial attempt + same-model transient retries.
        for attempt in range(self._max_retries + 1):
            try:
                async for chunk in self._raw_stream(
                    validated_model, messages, tools=tools,
                    tool_choice=tool_choice, temperature=temperature,
                    run_name=run_name,
                ):
                    produced = True
                    yield chunk
                return
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if produced:
                    log.warning(
                        "llm_stream_failed_after_output",
                        model=validated_model, error=str(exc),
                    )
                    raise
                if attempt < self._max_retries and _is_retryable(exc):
                    delay = self._backoff_delay(attempt)
                    log.warning(
                        "llm_stream_retry", model=validated_model,
                        attempt=attempt + 1, delay_s=round(delay, 3),
                        error=str(exc),
                    )
                    await asyncio.sleep(delay)
                    continue
                break  # exhausted retries OR non-retryable → try fallback

        # Fallback model: one attempt, only if nothing has streamed yet.
        if fallback_model is not None and not produced:
            log.warning(
                "llm_stream_fallback", primary=validated_model,
                fallback=fallback_model, error=str(last_exc),
            )
            try:
                async for chunk in self._raw_stream(
                    fallback_model, messages, tools=tools,
                    tool_choice=tool_choice, temperature=temperature,
                    run_name=run_name,
                ):
                    produced = True
                    yield chunk
                return
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if produced:
                    raise
                log.warning(
                    "llm_stream_fallback_failed",
                    fallback=fallback_model, error=str(exc),
                )

        assert last_exc is not None
        raise last_exc

    async def _raw_stream(
        self,
        validated_model: str,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None,
        tool_choice: str | None,
        temperature: float | None,
        run_name: str | None,
    ) -> AsyncIterator[CompletionChunk]:
        """One streaming attempt against `validated_model`, wrapped in its
        own Langfuse generation. No retry/fallback logic — that lives in
        `stream_completion`."""
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
        usage_cached = 0
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
                    if (cr := domain_chunk.get("cached_tokens")) is not None:
                        usage_cached = cr
                    yield domain_chunk
            finally:
                if gen is not None:
                    try:
                        gen_output: dict[str, Any] = {"text": "".join(text_acc)}
                        if tool_call_acc:
                            gen_output["tool_calls"] = tool_call_acc
                        gen.update(
                            output=gen_output,
                            usage_details=_usage_details(usage_in, usage_out, usage_cached),
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
        """Structured JSON call with transient-retry + model-fallback.

        One-shot (not streamed), so — unlike `stream_completion` — there's
        no partial-output constraint: every attempt is fully safe to
        retry. Same-model transient retries, then escalate to the
        fallback model (which also covers a model-specific parse failure).
        """
        validated_model = self._validate_model(model)
        fallback_model = self._fallback_for(validated_model)
        last_exc: BaseException | None = None

        for attempt in range(self._max_retries + 1):
            try:
                return await self._raw_structured(
                    validated_model, messages, schema, run_name=run_name,
                )
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if attempt < self._max_retries and _is_retryable(exc):
                    delay = self._backoff_delay(attempt)
                    log.warning(
                        "llm_structured_retry", model=validated_model,
                        attempt=attempt + 1, delay_s=round(delay, 3),
                        error=str(exc),
                    )
                    await asyncio.sleep(delay)
                    continue
                break

        if fallback_model is not None:
            log.warning(
                "llm_structured_fallback", primary=validated_model,
                fallback=fallback_model, error=str(last_exc),
            )
            try:
                return await self._raw_structured(
                    fallback_model, messages, schema, run_name=run_name,
                )
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                log.warning(
                    "llm_structured_fallback_failed",
                    fallback=fallback_model, error=str(exc),
                )

        assert last_exc is not None
        raise last_exc

    async def _raw_structured(
        self,
        validated_model: str,
        messages: list[Message],
        schema: type[T],
        *,
        run_name: str | None,
    ) -> T:
        """One structured-output attempt against `validated_model`. No
        retry/fallback — that lives in `structured_output`.

        temperature is forced to 0 regardless of what a Langfuse
        prompt-config carries. Routing / topic extraction / query
        expansion all rely on deterministic JSON output; non-zero
        temperature flaps the parser. The bootstrap script for Langfuse
        documents this explicitly so prompt editors don't expect
        temperature changes to take effect for structured_output prompts.
        """
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
                    usage_cached = 0
                    raw_msg = (
                        raw_and_parsed.get("raw")
                        if isinstance(raw_and_parsed, dict)
                        else None
                    )
                    if raw_msg is not None:
                        usage_meta = getattr(raw_msg, "usage_metadata", None) or {}
                        usage_in = usage_meta.get("input_tokens") or 0
                        usage_out = usage_meta.get("output_tokens") or 0
                        usage_cached = (usage_meta.get("input_token_details") or {}).get("cache_read") or 0
                    gen.update(
                        output=parsed.model_dump(),
                        usage_details=_usage_details(usage_in, usage_out, usage_cached),
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning("langfuse_generation_update_failed", error=str(exc))
            return parsed
