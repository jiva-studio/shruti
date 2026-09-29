"""Classifying provider failures: retry or not, and how long to wait, and
whether an exhausted failure means the provider is unavailable.

OpenRouter speaks the OpenAI wire format, so the `openai` SDK's exception
types and OpenRouter's documented error object are what gets classified.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import openai

from shruti_chat.domain.ports.llm_provider import ProviderUnavailable


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

    So both paths give us the documented object; `code` is read off it. Without
    this an in-band error has no `status_code` and would skip the retry path.
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


def retry_reason(exc: BaseException) -> str:
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


def is_retryable(exc: BaseException) -> bool:
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


def retry_after_s(exc: BaseException) -> float | None:
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
ERROR_FINISH_REASONS = frozenset({"error", "content_filter"})


def terminal_error(exc: BaseException) -> BaseException:
    """The exception to raise once retries AND the fallback model are spent.

    A vendor-availability failure becomes `ProviderUnavailable` so callers can
    classify it WITHOUT importing this adapter. Anything else propagates
    unchanged — a 400 or a 404 is our bug and must stay a generic error.

    All three public entry points (stream / structured / text) funnel their
    failure through here, so an availability error cannot leave this adapter
    unlabelled. The vendor exception is kept as `__cause__`.
    """
    if not is_provider_unavailable(exc):
        return exc
    wrapped = ProviderUnavailable(str(exc))
    wrapped.__cause__ = exc
    return wrapped


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
