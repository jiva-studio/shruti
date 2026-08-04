"""Transient-retry + model-fallback policy in OpenRouterLLMProvider.

The orchestration in `stream_completion` / `structured_output` is tested
by stubbing the per-attempt `_raw_stream` / `_raw_structured` so we drive
exactly which attempts fail and assert which models were tried. The
critical streaming invariant — never fall back after a chunk is already
on the wire — gets its own test.
"""

from __future__ import annotations

from langchain_core.messages import AIMessage, AIMessageChunk
from pydantic import BaseModel

import httpx
import openai

from lectorium_chat.config import Settings
from lectorium_chat.infra.llm_provider.openrouter import (
    EmptyCompletionError,
    OpenRouterLLMProvider,
    is_provider_unavailable,
)


# Retryable by virtue of a 5xx status_code; non-retryable has neither a
# retryable type nor a status_code, so `_is_retryable` returns False.
class _Transient(Exception):
    status_code = 503


class _Fatal(Exception):
    pass


class _Schema(BaseModel):
    value: str


def _provider(*, max_retries: int = 2) -> OpenRouterLLMProvider:
    s = Settings(
        openrouter_api_key="test-key",
        llm_default="openrouter/deepseek/deepseek-chat",
        llm_fallback="openrouter/anthropic/claude-haiku-4.5",
        llm_max_retries=max_retries,
        llm_retry_base_delay_s=0.0,  # no real sleep in tests
    )
    return OpenRouterLLMProvider(s)


def _stub_stream(provider, script):
    """script[i] = ("ok", [chunks]) | ("fail", exc, n_chunks_before_fail)."""
    calls: list[str] = []

    async def _raw_stream(model, messages, **_kw):
        action = script[len(calls)]
        calls.append(model)
        if action[0] == "ok":
            for ch in action[1]:
                yield ch
            return
        exc = action[1]
        n_before = action[2] if len(action) > 2 else 0
        for i in range(n_before):
            yield {"text": f"partial{i}"}
        raise exc

    provider._raw_stream = _raw_stream
    return calls


def _stub_structured(provider, script):
    calls: list[str] = []

    async def _raw_structured(model, messages, schema, *, run_name=None):
        action = script[len(calls)]
        calls.append(model)
        if action[0] == "ok":
            return action[1]
        raise action[1]

    provider._raw_structured = _raw_structured
    return calls


def _stub_text(provider, script):
    calls: list[str] = []

    async def _raw_text(model, messages, *, run_name=None):
        action = script[len(calls)]
        calls.append(model)
        if action[0] == "ok":
            return action[1]
        raise action[1]

    provider._raw_text = _raw_text
    return calls


async def _drain(agen) -> list:
    return [c async for c in agen]


# ── streaming ────────────────────────────────────────────────────────

async def test_stream_primary_success_no_retry_no_fallback():
    p = _provider()
    calls = _stub_stream(p, [("ok", [{"text": "hi"}])])
    out = await _drain(p.stream_completion([{"role": "user", "content": "q"}]))
    assert [c["text"] for c in out] == ["hi"]
    assert calls == [p._default_model]


async def test_stream_retries_same_model_then_succeeds():
    p = _provider(max_retries=2)
    calls = _stub_stream(p, [
        ("fail", _Transient(), 0),
        ("ok", [{"text": "hi"}]),
    ])
    out = await _drain(p.stream_completion([{"role": "user", "content": "q"}]))
    assert [c["text"] for c in out] == ["hi"]
    assert calls == [p._default_model, p._default_model]


async def test_stream_escalates_to_fallback_after_primary_exhausted():
    p = _provider(max_retries=1)
    calls = _stub_stream(p, [
        ("fail", _Transient(), 0),  # attempt 0
        ("fail", _Transient(), 0),  # retry (attempt 1) — exhausts primary
        ("ok", [{"text": "fb"}]),   # fallback model
    ])
    out = await _drain(p.stream_completion([{"role": "user", "content": "q"}]))
    assert [c["text"] for c in out] == ["fb"]
    assert calls == [p._default_model, p._default_model, p._fallback_model]


async def test_stream_non_retryable_skips_retries_straight_to_fallback():
    p = _provider(max_retries=2)
    calls = _stub_stream(p, [
        ("fail", _Fatal(), 0),     # non-retryable → no same-model retry
        ("ok", [{"text": "fb"}]),
    ])
    out = await _drain(p.stream_completion([{"role": "user", "content": "q"}]))
    assert [c["text"] for c in out] == ["fb"]
    assert calls == [p._default_model, p._fallback_model]


async def test_stream_failure_after_first_chunk_reraises_no_fallback():
    """Once a chunk is on the wire we must NOT fall back — re-raise."""
    p = _provider(max_retries=2)
    calls = _stub_stream(p, [("fail", _Transient(), 1)])  # 1 chunk then fail
    seen = []
    raised = False
    try:
        async for c in p.stream_completion([{"role": "user", "content": "q"}]):
            seen.append(c)
    except _Transient:
        raised = True
    assert raised
    assert [c["text"] for c in seen] == ["partial0"]
    assert calls == [p._default_model]  # no fallback attempted


async def test_stream_raises_when_all_attempts_fail():
    p = _provider(max_retries=1)
    _stub_stream(p, [
        ("fail", _Transient(), 0),
        ("fail", _Transient(), 0),
        ("fail", _Transient(), 0),  # fallback also fails
    ])
    raised = False
    try:
        await _drain(p.stream_completion([{"role": "user", "content": "q"}]))
    except _Transient:
        raised = True
    assert raised


# ── structured ───────────────────────────────────────────────────────

async def test_structured_retries_then_succeeds():
    p = _provider(max_retries=2)
    calls = _stub_structured(p, [
        ("fail", _Transient()),
        ("ok", _Schema(value="x")),
    ])
    res = await p.structured_output([{"role": "user", "content": "q"}], _Schema)
    assert res.value == "x"
    assert calls == [p._default_model, p._default_model]


async def test_structured_escalates_to_fallback():
    p = _provider(max_retries=1)
    calls = _stub_structured(p, [
        ("fail", _Transient()),
        ("fail", _Transient()),
        ("ok", _Schema(value="fb")),
    ])
    res = await p.structured_output([{"role": "user", "content": "q"}], _Schema)
    assert res.value == "fb"
    assert calls == [p._default_model, p._default_model, p._fallback_model]


async def test_structured_raises_when_all_fail():
    p = _provider(max_retries=0)
    _stub_structured(p, [
        ("fail", _Fatal()),   # primary (no retries)
        ("fail", _Fatal()),   # fallback
    ])
    raised = False
    try:
        await p.structured_output([{"role": "user", "content": "q"}], _Schema)
    except _Fatal:
        raised = True
    assert raised


# ── text_completion (plain-prose path) ───────────────────────────────

async def test_text_primary_success_no_retry_no_fallback():
    p = _provider()
    calls = _stub_text(p, [("ok", "a blurb")])
    out = await p.text_completion([{"role": "user", "content": "q"}])
    assert out == "a blurb"
    assert calls == [p._default_model]


async def test_text_retries_same_model_then_succeeds():
    p = _provider(max_retries=2)
    calls = _stub_text(p, [
        ("fail", _Transient()),
        ("ok", "recovered"),
    ])
    out = await p.text_completion([{"role": "user", "content": "q"}])
    assert out == "recovered"
    assert calls == [p._default_model, p._default_model]


async def test_text_escalates_to_fallback():
    p = _provider(max_retries=1)
    calls = _stub_text(p, [
        ("fail", _Transient()),
        ("fail", _Transient()),
        ("ok", "fb"),
    ])
    out = await p.text_completion([{"role": "user", "content": "q"}])
    assert out == "fb"
    assert calls == [p._default_model, p._default_model, p._fallback_model]


async def test_text_raises_when_all_fail():
    p = _provider(max_retries=0)
    _stub_text(p, [
        ("fail", _Fatal()),   # primary (no retries)
        ("fail", _Fatal()),   # fallback
    ])
    raised = False
    try:
        await p.text_completion([{"role": "user", "content": "q"}])
    except _Fatal:
        raised = True
    assert raised


# ── empty-completion stream (silent provider failure) ──────────────────


class _FakeAstreamClient:
    """Stands in for the pooled ChatOpenAI: `astream` replays a scripted
    list of AIMessageChunk objects then ends cleanly (no exception)."""

    def __init__(self, chunks: list[AIMessageChunk]) -> None:
        self._chunks = chunks

    def bind_tools(self, **_kw):  # pragma: no cover - tools unused here
        return self

    async def astream(self, _msgs):
        for ch in self._chunks:
            yield ch


def _text_chunk(text: str) -> AIMessageChunk:
    return AIMessageChunk(content=text)


def _finish_chunk(reason: str) -> AIMessageChunk:
    # finish_reason rides in response_metadata, mirroring ChatOpenAI.
    return AIMessageChunk(content="", response_metadata={"finish_reason": reason})


def _patch_client(provider, chunks: list[AIMessageChunk]) -> None:
    provider._client_for = lambda *a, **k: _FakeAstreamClient(chunks)


async def test_raw_stream_raises_empty_completion_on_blank_stream():
    """A clean SSE end with zero text AND zero tool calls is NOT a blank
    answer — `_raw_stream` raises the typed `EmptyCompletionError`."""
    p = _provider()
    _patch_client(p, [_finish_chunk("stop")])  # only metadata, no output
    raised = False
    try:
        async for _ in p._raw_stream(
            p._default_model, [{"role": "user", "content": "q"}],
            tools=None, tool_choice=None, temperature=None, run_name=None,
        ):
            pass
    except EmptyCompletionError:
        raised = True
    assert raised


async def test_raw_stream_raises_on_error_finish_reason():
    """An error-class finish_reason with no usable output is treated as
    a failed completion, not a (blank) success."""
    p = _provider()
    _patch_client(p, [_finish_chunk("content_filter")])
    raised = False
    try:
        async for _ in p._raw_stream(
            p._default_model, [{"role": "user", "content": "q"}],
            tools=None, tool_choice=None, temperature=None, run_name=None,
        ):
            pass
    except EmptyCompletionError:
        raised = True
    assert raised


async def test_raw_stream_ok_when_text_present():
    """A normal stream with text never raises EmptyCompletionError."""
    p = _provider()
    _patch_client(p, [_text_chunk("hello"), _finish_chunk("stop")])
    out = await _drain(p._raw_stream(
        p._default_model, [{"role": "user", "content": "q"}],
        tools=None, tool_choice=None, temperature=None, run_name=None,
    ))
    assert "".join(c.get("text", "") for c in out) == "hello"


async def test_empty_primary_stream_falls_back_to_other_model():
    """An empty primary `_raw_stream` (EmptyCompletionError) is retryable:
    `stream_completion` exhausts the primary then escalates to the
    fallback model, which answers."""
    p = _provider(max_retries=1)
    calls = _stub_stream(p, [
        ("fail", EmptyCompletionError("empty"), 0),  # attempt 0
        ("fail", EmptyCompletionError("empty"), 0),  # retry → exhausts primary
        ("ok", [{"text": "fb-answer"}]),             # fallback model answers
    ])
    out = await _drain(p.stream_completion([{"role": "user", "content": "q"}]))
    assert [c["text"] for c in out] == ["fb-answer"]
    assert calls == [p._default_model, p._default_model, p._fallback_model]


async def test_exhausted_empty_stream_maps_to_provider_unavailable():
    """When every attempt comes back empty the final EmptyCompletionError
    is classified as provider-unavailable → the turn surfaces a calm
    `chat_unavailable` rather than a generic agent error."""
    p = _provider(max_retries=0)
    _stub_stream(p, [
        ("fail", EmptyCompletionError("empty")),  # primary
        ("fail", EmptyCompletionError("empty")),  # fallback
    ])
    raised: BaseException | None = None
    try:
        await _drain(p.stream_completion([{"role": "user", "content": "q"}]))
    except EmptyCompletionError as exc:
        raised = exc
    assert raised is not None
    assert is_provider_unavailable(raised)


# ── _raw_text: no JSON asked, output cleaned ──────────────────────────


class _FakeInvokeClient:
    """Stands in for the pooled ChatOpenAI in `_raw_text`: a plain
    non-streaming `ainvoke` returning one AIMessage. Note it has NO
    `with_structured_output` — the plain-text path must never ask for JSON."""

    def __init__(self, content: str) -> None:
        self._content = content

    async def ainvoke(self, _msgs):
        return AIMessage(content=self._content)


async def test_raw_text_returns_bare_string_no_json_requested():
    p = _provider()
    p._client_for = lambda *a, **k: _FakeInvokeClient("Лекция о выборе супруга.")
    out = await p._raw_text(
        p._default_model, [{"role": "user", "content": "q"}], run_name="t",
    )
    assert out == "Лекция о выборе супруга."


async def test_raw_text_strips_fence_and_quotes():
    p = _provider()
    p._client_for = lambda *a, **k: _FakeInvokeClient('```\n"готовый текст"\n```')
    out = await p._raw_text(
        p._default_model, [{"role": "user", "content": "q"}], run_name="t",
    )
    assert out == "готовый текст"


async def test_raw_text_empty_is_valid_empty_string():
    p = _provider()
    p._client_for = lambda *a, **k: _FakeInvokeClient("   ")
    out = await p._raw_text(
        p._default_model, [{"role": "user", "content": "q"}], run_name="t",
    )
    assert out == ""


# ── in-band OpenRouter errors (arrive on a 200, no status_code) ───────
#
# OpenRouter documents ONE error object — `{"error": {"code": <http status>,
# "message": …}}` — and delivers it two ways. Before the first token the HTTP
# status is real and the SDK types the exception. Mid-stream it cannot be (the
# 200 and its headers are already committed), so the SAME object arrives in-band
# and reaches us as an untyped exception with no `status_code`:
#   - streaming     → `openai.APIError(…, body=data["error"])`
#   - non-streaming → langchain_openai's `ValueError(response["error"])`
# https://openrouter.ai/docs/api-reference/errors
#
# That was the gap: 16 of 18 ERROR-level observations in two weeks were 429s in
# one of these shapes, so they never reached the retry path.


def _langchain_in_band(code: int = 429) -> ValueError:
    """What langchain_openai raises for a non-streamed response carrying an
    `error` body: `raise ValueError(response_dict.get("error"))` — the single
    arg IS the documented error object."""
    return ValueError({"message": "Provider returned error", "code": code})


def _sdk_in_band(code: int = 429) -> openai.APIError:
    """What `openai._streaming` raises for an in-band error chunk:
    `APIError(message, request, body=data["error"])`."""
    return openai.APIError(
        "Provider returned error",
        httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions"),
        body={"message": "temporarily rate-limited upstream", "code": code},
    )


async def test_langchain_in_band_rate_limit_is_retried():
    p = _provider(max_retries=2)
    calls = _stub_structured(p, [
        ("fail", _langchain_in_band()),
        ("ok", _Schema(value="x")),
    ])
    res = await p.structured_output([{"role": "user", "content": "q"}], _Schema)
    assert res.value == "x"
    # Same model retried — before the fix this went straight to the fallback,
    # and `find_tracks_description` silently lost its card blurbs.
    assert calls == [p._default_model, p._default_model]


async def test_sdk_in_band_rate_limit_is_retried():
    p = _provider(max_retries=2)
    calls = _stub_text(p, [
        ("fail", _sdk_in_band()),
        ("ok", "blurb"),
    ])
    out = await p.text_completion([{"role": "user", "content": "q"}])
    assert out == "blurb"
    assert calls == [p._default_model, p._default_model]


async def test_in_band_5xx_is_retried():
    # 502 "model unavailable", 503 "no provider meets the routing requirements".
    p = _provider(max_retries=1)
    calls = _stub_structured(p, [
        ("fail", _langchain_in_band(503)),
        ("ok", _Schema(value="x")),
    ])
    await p.structured_output([{"role": "user", "content": "q"}], _Schema)
    assert calls == [p._default_model, p._default_model]


async def test_in_band_400_is_not_retried():
    # Our own bad request fails identically on a retry — don't burn the budget.
    p = _provider(max_retries=2)
    calls = _stub_structured(p, [
        ("fail", _langchain_in_band(400)),
        ("ok", _Schema(value="fb")),
    ])
    await p.structured_output([{"role": "user", "content": "q"}], _Schema)
    assert calls == [p._default_model, p._fallback_model]


async def test_a_plain_value_error_is_not_read_as_a_provider_error():
    # Only a ValueError whose arg is the documented error MAPPING counts; an
    # ordinary one from our own code must not look like a rate limit.
    p = _provider(max_retries=2)
    calls = _stub_structured(p, [
        ("fail", ValueError("not a provider error")),
        ("ok", _Schema(value="fb")),
    ])
    await p.structured_output([{"role": "user", "content": "q"}], _Schema)
    assert calls == [p._default_model, p._fallback_model]


async def test_exhausted_in_band_rate_limit_reads_as_provider_unavailable():
    # So the turn ends on a calm "chat temporarily unavailable" instead of a
    # generic agent error: retries AND the fallback model are already spent.
    assert is_provider_unavailable(_langchain_in_band())
    assert is_provider_unavailable(_sdk_in_band())
    assert not is_provider_unavailable(_langchain_in_band(400))


# ── Retry-After ───────────────────────────────────────────────────────
# OpenRouter documents the header as the primary delay source on a 429.


def _rate_limited_with_retry_after(value: str) -> openai.RateLimitError:
    request = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
    response = httpx.Response(429, headers={"retry-after": value}, request=request)
    return openai.RateLimitError("rate limited", response=response, body=None)


async def test_retry_after_is_honoured_over_our_own_backoff(monkeypatch):
    slept: list[float] = []

    async def _record(delay: float) -> None:
        slept.append(delay)

    monkeypatch.setattr(
        "lectorium_chat.infra.llm_provider.openrouter.asyncio.sleep", _record
    )
    p = _provider(max_retries=1)
    _stub_structured(p, [
        ("fail", _rate_limited_with_retry_after("2")),
        ("ok", _Schema(value="x")),
    ])
    await p.structured_output([{"role": "user", "content": "q"}], _Schema)
    assert slept == [2.0]


async def test_an_unreasonably_long_retry_after_is_ignored(monkeypatch):
    # A person is waiting on the turn: past a few seconds, escalating to the
    # fallback model beats sitting on the provider's wait. `llm_retry_base_delay_s`
    # is 0 in tests, so our own backoff draws 0.
    slept: list[float] = []

    async def _record(delay: float) -> None:
        slept.append(delay)

    monkeypatch.setattr(
        "lectorium_chat.infra.llm_provider.openrouter.asyncio.sleep", _record
    )
    p = _provider(max_retries=1)
    _stub_structured(p, [
        ("fail", _rate_limited_with_retry_after("600")),
        ("ok", _Schema(value="x")),
    ])
    await p.structured_output([{"role": "user", "content": "q"}], _Schema)
    assert slept == [0.0]
