"""Transient-retry + model-fallback policy in OpenRouterLLMProvider.

The orchestration in `stream_completion` / `structured_output` is tested
by stubbing the per-attempt `_raw_stream` / `_raw_structured` so we drive
exactly which attempts fail and assert which models were tried. The
critical streaming invariant — never fall back after a chunk is already
on the wire — gets its own test.
"""

from __future__ import annotations

from pydantic import BaseModel

from shruti_chat.config import Settings
from shruti_chat.infra.llm_provider.openrouter import OpenRouterLLMProvider


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
        _, exc, n_before = action
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
