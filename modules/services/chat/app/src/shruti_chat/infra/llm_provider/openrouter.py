"""OpenRouter adapter for `LLMPort`.

OpenRouter exposes an OpenAI-compatible API at `https://openrouter.ai/api/v1`,
so we point `langchain_openai.ChatOpenAI` at it via `base_url` and let the
provider route by model prefix (`google/gemini-3.1-flash-lite`,
`anthropic/claude-haiku-4.5`, ...).

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
from collections.abc import Mapping
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
from pydantic import BaseModel, ValidationError

from shruti_chat.config import Settings
from shruti_chat.domain.entities import CompletionChunk, Message, ToolCallDelta
from shruti_chat.observability.langfuse_client import get_langfuse
from shruti_chat.observability.logging import get_logger
from shruti_chat.observability.metrics import (
    llm_fallback_counter,
    llm_retry_counter,
)


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


def _in_band_error(exc: BaseException) -> Mapping[str, Any] | None:
    """The OpenRouter `error` object an exception carries, if any.

    OpenRouter documents ONE error shape — `{"error": {"code": <http status>,
    "message": …, "metadata"?: …}}` — and two ways of delivering it. Before the
    first token the status is real, and the SDK turns it into a typed exception
    (`RateLimitError`, …). Mid-stream it cannot be: the 200 and its headers are
    already committed, so the error arrives IN-BAND as an SSE chunk carrying
    that same object plus `finish_reason: "error"`.
    https://openrouter.ai/docs/api-reference/errors

    Who hands the in-band object to us:
      - streaming — `openai._streaming` raises `APIError(…, body=data["error"])`
      - non-streaming — langchain_openai raises `ValueError(response["error"])`

    So both paths give us the documented object; `code` is read off it. This is
    the gap that let 16 of 18 ERROR-level observations in two weeks skip the
    retry path (no `status_code` to look at), one of them leaving the user with
    an empty answer after 36 seconds.
    """
    if isinstance(exc, openai.APIError) and isinstance(exc.body, Mapping):
        return exc.body
    if isinstance(exc, ValueError) and exc.args and isinstance(exc.args[0], Mapping):
        return exc.args[0]
    return None


def _error_status(exc: BaseException) -> int | None:
    """HTTP-equivalent status for `exc`: the real one when the SDK typed it,
    else the `code` from an in-band OpenRouter error. Documented as a number;
    tolerate a string in case a provider stringifies it."""
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    body = _in_band_error(exc)
    if body is None:
        return None
    try:
        return int(body.get("code"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _retry_reason(exc: BaseException) -> str:
    """Bucket a failed attempt for the retry counter.

    Deliberately coarse and closed-set — the label has to stay bounded, and
    what an operator needs at 3am is "are we being rate limited or is the
    provider down", not the exception text (which is already in the log line
    right next to every increment)."""
    if isinstance(exc, EmptyCompletionError):
        return "empty_completion"
    status = _error_status(exc)
    if status == 429:
        return "rate_limited"
    if isinstance(status, int) and 500 <= status < 600:
        return "server_error"
    if isinstance(exc, openai.APITimeoutError):
        return "timeout"
    if isinstance(exc, openai.APIConnectionError):
        return "connection"
    return "other"


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, _RETRYABLE_EXC):
        return True
    # A clean-but-empty stream is worth one more roll of the dice on the
    # same model, then the fallback model (see `EmptyCompletionError`).
    if isinstance(exc, EmptyCompletionError):
        return True
    # 429 (rate limited) and 5xx (502 model unavailable / 503 no provider meets
    # the routing requirements) — whether the SDK typed them or they arrived
    # in-band on a 200.
    status = _error_status(exc)
    return isinstance(status, int) and (status == 429 or 500 <= status < 600)


# Cap on an honoured `Retry-After`. OpenRouter documents the header as the
# primary delay source on a 429, but a chat turn has a person waiting on it:
# past a few seconds, escalating to the fallback model (the next step anyway)
# beats sitting on the wait the provider asked for.
_RETRY_AFTER_MAX_S = 5.0


def _retry_after_s(exc: BaseException) -> float | None:
    """Seconds from the `Retry-After` header, when the provider sent one and it
    is short enough to be worth honouring. The HTTP-date form is not parsed —
    OpenRouter sends delay-seconds — and an absent/unusable value means "use
    our own backoff"."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    try:
        seconds = float(headers.get("retry-after"))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if seconds <= 0 or seconds > _RETRY_AFTER_MAX_S:
        return None
    return seconds


def _extract_json_object(text: str) -> str | None:
    """Pull the first balanced JSON object/array out of a model response.

    Models routinely emit valid JSON wrapped in a ```json fence and/or
    surrounded by prose ("Вот сгенерированный JSON:" … / "Hope this helps!").
    A strict JSON parser chokes on the first non-JSON character. Scan to the
    first `{`/`[`, walk to its matching close (string- and escape-aware so
    braces inside string values don't fool it), and return just that slice.
    Returns None when there's no JSON-looking object at all (genuine prose /
    refusal), so the caller can fail cleanly into retry/fallback.
    """
    if not text:
        return None
    start = next((i for i, c in enumerate(text) if c in "{["), None)
    if start is None:
        return None
    open_ch = text[start]
    close_ch = "}" if open_ch == "{" else "]"
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _strip_plain_text(text: str) -> str:
    """Clean a plain-text prose reply from a cheap model. Small models
    sometimes wrap a one-liner in a ``` fence or matching quotes even when
    not asked to. Strip one such layer so the card/intro reads clean.
    """
    s = text.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        s = (s[nl + 1 :] if nl != -1 else "").strip()
        if s.endswith("```"):
            s = s[:-3].strip()
    # One layer of symmetric wrapping quotes ("…", '…', «…», “…”).
    _PAIRS = {'"': '"', "'": "'", "«": "»", "“": "”"}
    if len(s) >= 2 and s[0] in _PAIRS and s[-1] == _PAIRS[s[0]]:
        s = s[1:-1].strip()
    return s


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


class EmptyCompletionError(Exception):
    """A streaming completion ended cleanly but produced no text AND no
    tool call — or finished with an error-class `finish_reason`. The SSE
    stream closes normally in this case, so the `openai` SDK never raises;
    without this typed signal `stream_completion`'s retry/fallback loop
    would treat the blank stream as a successful (empty) answer.

    Mapped as RETRYABLE so the same-model retry + fallback-model escalation
    fire, and tagged provider-unavailable so a fully-exhausted empty stream
    surfaces as a calm `chat_unavailable` (the upstream answered with
    nothing — out of capacity / content-filtered — not our bug)."""


# `finish_reason` values that mean the provider aborted rather than
# completed: a stream that ends on one of these with no usable output is
# an upstream failure, not a deliberate empty answer. "stop"/"tool_calls"/
# "length" are legitimate terminations and never treated as empty here.
_ERROR_FINISH_REASONS = frozenset({"error", "content_filter"})


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
        if isinstance(cur, (_UNAVAILABLE_EXC, EmptyCompletionError)):
            return True
        # `_error_status` also reads the code out of an IN-BAND OpenRouter
        # error (mid-stream failures arrive on a 200 with no `status_code`).
        # Once retries AND the fallback model are spent on one of those, it is a
        # capacity problem upstream, so the user gets "try again later" rather
        # than a generic error.
        status = _error_status(cur)
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
        settings.llm_cheap,
        settings.llm_query_planner,
        settings.llm_synthesis_planner,
        settings.llm_conclusion_writer,
        settings.llm_translate,
        settings.llm_fallback_knowledge,
        # Curated known-good ids. This is now a HINT, not a gate: a model
        # outside this set is still used (with a loud warning) so changing a
        # model in Langfuse prompt-config doesn't need a code deploy. Listing
        # a vetted model here just silences the warning. See `_validate_model`.
        "openrouter/anthropic/claude-haiku-4.5",
        "openrouter/google/gemini-2.5-flash-lite",
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
        # deepseek-chat, claude-haiku-4.5), so it never trips a 400. The
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

        # `produced` gates retry/fallback: once real OUTPUT (text or a
        # tool-call delta) is on the wire we can't re-roll. A bare
        # finish_reason / usage chunk is metadata, not output, so it must
        # NOT flip this — otherwise a stream that ends empty (and `_raw_stream`
        # raises `EmptyCompletionError`) right after emitting only a
        # finish_reason chunk would be wrongly treated as un-retryable.
        def _has_output(chunk: CompletionChunk) -> bool:
            return bool(chunk.get("text") or chunk.get("tool_calls"))

        # Primary model: initial attempt + same-model transient retries.
        for attempt in range(self._max_retries + 1):
            try:
                async for chunk in self._raw_stream(
                    validated_model, messages, tools=tools,
                    tool_choice=tool_choice, temperature=temperature,
                    run_name=run_name,
                ):
                    if _has_output(chunk):
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
                    delay = _retry_after_s(exc) or self._backoff_delay(attempt)
                    llm_retry_counter.labels(
                        call="stream", reason=_retry_reason(exc),
                    ).inc()
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
            llm_fallback_counter.labels(call="stream", outcome="escalated").inc()
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
                    if _has_output(chunk):
                        produced = True
                    yield chunk
                return
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if produced:
                    raise
                llm_fallback_counter.labels(call="stream", outcome="exhausted").inc()
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
        # An OpenAI-compatible stream that ends cleanly with zero text and
        # zero tool-call deltas is NOT a success — it's an upstream failure
        # the SDK doesn't raise on (the HTTP stream closed 200/OK with an
        # empty body). Track whether anything usable came through, plus the
        # last `finish_reason`, and raise a typed `EmptyCompletionError`
        # AFTER the stream drains so the generation span still closes and
        # `stream_completion`'s retry/fallback engages. We only raise when
        # NOTHING was yielded — a mid-stream truncation that already emitted
        # text is re-raised verbatim upstream (can't be re-rolled).
        produced_any = False
        last_finish_reason: str | None = None
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
                        produced_any = True
                    if (tc := domain_chunk.get("tool_calls")):
                        tool_call_acc.extend(tc)
                        produced_any = True
                    if (pt := domain_chunk.get("prompt_tokens")) is not None:
                        usage_in = pt
                    if (ct := domain_chunk.get("completion_tokens")) is not None:
                        usage_out = ct
                    if (cr := domain_chunk.get("cached_tokens")) is not None:
                        usage_cached = cr
                    if (fr := domain_chunk.get("finish_reason")):
                        last_finish_reason = fr
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

        # Raise OUTSIDE the generation context so the span above closed with
        # whatever (empty) output it had. A clean stream that produced no
        # text and no tool call — or one that ended on an error-class
        # finish_reason — is an upstream failure, not a blank answer.
        if not produced_any or last_finish_reason in _ERROR_FINISH_REASONS:
            log.warning(
                "llm_stream_empty_completion",
                model=validated_model,
                finish_reason=last_finish_reason,
                produced_any=produced_any,
            )
            raise EmptyCompletionError(
                f"empty completion from {validated_model} "
                f"(finish_reason={last_finish_reason})"
            )

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
                    delay = _retry_after_s(exc) or self._backoff_delay(attempt)
                    llm_retry_counter.labels(
                        call="structured", reason=_retry_reason(exc),
                    ).inc()
                    log.warning(
                        "llm_structured_retry", model=validated_model,
                        attempt=attempt + 1, delay_s=round(delay, 3),
                        error=str(exc),
                    )
                    await asyncio.sleep(delay)
                    continue
                break

        if fallback_model is not None:
            llm_fallback_counter.labels(call="structured", outcome="escalated").inc()
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
                llm_fallback_counter.labels(call="structured", outcome="exhausted").inc()
                log.warning(
                    "llm_structured_fallback_failed",
                    fallback=fallback_model, error=str(exc),
                )

        assert last_exc is not None
        raise last_exc

    async def text_completion(
        self,
        messages: list[Message],
        *,
        model: str | None = None,
        run_name: str | None = None,
    ) -> str:
        """One-shot plain-text completion with transient-retry + model
        fallback — for callers whose whole payload is a single prose string
        (a card blurb, an intro/conclusion line). No JSON envelope is asked
        of the model, so there is no parse step to miss: a JSON round-trip
        around one sentence only buys wasted retries + latency on weak
        models. Returns the (cleaned) text; "" is a valid "nothing to say".

        Mirrors `structured_output`'s orchestration: same-model transient
        retries, then escalate to the fallback model.
        """
        validated_model = self._validate_model(model)
        fallback_model = self._fallback_for(validated_model)
        last_exc: BaseException | None = None

        for attempt in range(self._max_retries + 1):
            try:
                return await self._raw_text(
                    validated_model, messages, run_name=run_name,
                )
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if attempt < self._max_retries and _is_retryable(exc):
                    delay = _retry_after_s(exc) or self._backoff_delay(attempt)
                    llm_retry_counter.labels(
                        call="text", reason=_retry_reason(exc),
                    ).inc()
                    log.warning(
                        "llm_text_retry", model=validated_model,
                        attempt=attempt + 1, delay_s=round(delay, 3),
                        error=str(exc),
                    )
                    await asyncio.sleep(delay)
                    continue
                break

        if fallback_model is not None:
            llm_fallback_counter.labels(call="text", outcome="escalated").inc()
            log.warning(
                "llm_text_fallback", primary=validated_model,
                fallback=fallback_model, error=str(last_exc),
            )
            try:
                return await self._raw_text(
                    fallback_model, messages, run_name=run_name,
                )
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                llm_fallback_counter.labels(call="text", outcome="exhausted").inc()
                log.warning(
                    "llm_text_fallback_failed",
                    fallback=fallback_model, error=str(exc),
                )

        assert last_exc is not None
        raise last_exc

    async def _raw_text(
        self,
        validated_model: str,
        messages: list[Message],
        *,
        run_name: str | None,
    ) -> str:
        """One plain-text completion against `validated_model`. No
        retry/fallback (that lives in `text_completion`), no JSON /
        `response_format` — the model just writes prose and we return the
        cleaned string. Same Langfuse generation + usage bookkeeping and the
        same one-shot `streaming=False` (so `usage_metadata` survives) as
        `_raw_structured`. temperature is forced to 0 for deterministic,
        cache-friendly output (these are short localized one-liners).
        """
        client = self._client_for(validated_model, temperature=0, streaming=False)
        lc_msgs = [_to_langchain_message(m) for m in messages]
        gen_ctx = self._generation_ctx(
            name=run_name,
            model=validated_model,
            messages=messages,
            model_parameters={"temperature": 0},
        )
        with gen_ctx as gen:
            raw_msg: Any = await client.ainvoke(lc_msgs)
            raw_text = getattr(raw_msg, "content", "") or ""
            if not isinstance(raw_text, str):
                raw_text = str(raw_text)
            text = _strip_plain_text(raw_text)

            if gen is not None:
                try:
                    usage_meta = getattr(raw_msg, "usage_metadata", None) or {}
                    usage_in = usage_meta.get("input_tokens") or 0
                    usage_out = usage_meta.get("output_tokens") or 0
                    usage_cached = (
                        usage_meta.get("input_token_details") or {}
                    ).get("cache_read") or 0
                    gen.update(
                        output=text,
                        usage_details=_usage_details(usage_in, usage_out, usage_cached),
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning("langfuse_generation_update_failed", error=str(exc))
            return text

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
            raw_msg: Any = None
            parsed: Any = None
            try:
                raw_and_parsed: Any = await structured.ainvoke(lc_msgs)
                if isinstance(raw_and_parsed, dict):
                    raw_msg = raw_and_parsed.get("raw")
                    parsed = raw_and_parsed.get("parsed")
                else:
                    parsed = raw_and_parsed
            except ValidationError:
                # Some langchain builds raise on a parse failure instead of
                # returning {"parsed": None}. We don't read the exception —
                # we re-fetch the raw text cleanly below and salvage from it.
                parsed = None

            if not isinstance(parsed, schema):
                # The structured parser couldn't read the response — almost
                # always because the model wrapped valid JSON in a ```json
                # fence or prose ("Вот JSON:" …). Salvage from the RAW model
                # message (not by mining the parse error). If we don't have
                # the raw message (parser raised), do one clean plain
                # completion to get the text.
                if raw_msg is None:
                    raw_msg = await client.ainvoke(lc_msgs)
                raw_text = getattr(raw_msg, "content", "") or ""
                if not isinstance(raw_text, str):
                    raw_text = str(raw_text)
                candidate = _extract_json_object(raw_text)
                salvaged = None
                if candidate is not None:
                    try:
                        salvaged = schema.model_validate_json(candidate)
                    except ValidationError:
                        salvaged = None
                if not isinstance(salvaged, schema):
                    raise RuntimeError(
                        f"structured_output: no parseable {schema.__name__} "
                        f"JSON in model output"
                    )
                log.info(
                    "structured_output_salvaged",
                    model=validated_model, schema=schema.__name__,
                )
                parsed = salvaged

            if gen is not None:
                try:
                    usage_in = 0
                    usage_out = 0
                    usage_cached = 0
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
