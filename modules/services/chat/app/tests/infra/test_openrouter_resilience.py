"""Transient-retry + model-fallback policy in OpenRouterLLMProvider.

The orchestration in `stream_completion` / `structured_output` is tested
by stubbing the per-attempt `_raw_stream` / `_raw_structured` so we drive
exactly which attempts fail and assert which models were tried. The
critical streaming invariant — never fall back after a chunk is already
on the wire — gets its own test.
"""

from __future__ import annotations

from langchain_core.messages import AIMessageChunk
from pydantic import BaseModel

from shruti_chat.config import Settings
from shruti_chat.infra.llm_provider.openrouter import (
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
        llm_fallback="openrouter/anthropic/claude-3-haiku",
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
