"""Tests for `infra/llm_provider/yandex.py`.

Uses `httpx.MockTransport` directly — the project doesn't pull in
`respx` or `pytest-httpx` (see existing test patterns under tests/),
so we patch the adapter's internal client by reaching into private
state. Acceptable for an adapter test where the seam IS the http
client.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from pydantic import BaseModel

from lectorium_chat.config import Settings
from lectorium_chat.infra.llm_provider.yandex import YandexLLMProvider


def _make_settings(**overrides: Any) -> Settings:
    """Settings with the minimum Yandex creds populated.

    The model_validator on Settings fails without folder + key when
    `llm_provider="yandex"`; explicit values keep tests independent
    of the environment.
    """
    base: dict[str, Any] = {
        "llm_provider": "yandex",
        "yandex_gpt_folder_id": "test-folder",
        "yandex_gpt_api_key": "test-api-key",
        "llm_default": "yandexgpt-lite/latest",
        # Disable Langfuse / observability noise.
        "stage_timing_enabled": False,
        "indexer_bootstrap_on_start": False,
    }
    base.update(overrides)
    return Settings(**base)


def _build_provider_with_handler(
    handler, settings: Settings | None = None,
) -> YandexLLMProvider:
    """Construct the adapter, then swap its httpx client for one wired
    to a MockTransport that runs `handler(request) -> Response`."""
    s = settings or _make_settings()
    provider = YandexLLMProvider(s)
    transport = httpx.MockTransport(handler)
    # The adapter holds its own AsyncClient; closing it before
    # replacement is hygiene (no real conn created yet, so cheap).
    provider._client = httpx.AsyncClient(  # type: ignore[attr-defined]
        transport=transport,
        timeout=httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=5.0),
    )
    return provider


def _stream_response(chunks: list[dict[str, Any]]) -> httpx.Response:
    """Build a fake newline-JSON streaming response body."""
    body = "\n".join(json.dumps(c) for c in chunks) + "\n"
    return httpx.Response(
        200,
        content=body.encode("utf-8"),
        headers={"content-type": "application/json"},
    )


async def _collect(it: AsyncIterator[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    async for c in it:
        out.append(dict(c))
    return out


async def test_stream_cumulative_to_delta_extraction() -> None:
    """Yandex sends cumulative text; adapter must yield deltas only."""
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return _stream_response([
            {
                "result": {
                    "alternatives": [{
                        "message": {"role": "assistant", "text": "Hello"},
                        "status": "ALTERNATIVE_STATUS_PARTIAL",
                    }],
                },
            },
            {
                "result": {
                    "alternatives": [{
                        "message": {"role": "assistant", "text": "Hello, world"},
                        "status": "ALTERNATIVE_STATUS_PARTIAL",
                    }],
                },
            },
            {
                "result": {
                    "alternatives": [{
                        "message": {
                            "role": "assistant",
                            "text": "Hello, world!",
                        },
                        "status": "ALTERNATIVE_STATUS_FINAL",
                    }],
                    "usage": {
                        "inputTextTokens": "5",
                        "completionTokens": "3",
                        "totalTokens": "8",
                    },
                },
            },
        ])

    provider = _build_provider_with_handler(handler)
    chunks = await _collect(
        provider.stream_completion(
            [{"role": "user", "content": "say hi"}],
            model="yandexgpt-lite/latest",
        )
    )
    # First chunk: full prefix "Hello".
    # Second chunk: delta ", world".
    # Third chunk: delta "!" + finish_reason + usage.
    texts = [c.get("text", "") for c in chunks if "text" in c]
    assert "".join(texts) == "Hello, world!"
    assert chunks[0]["text"] == "Hello"
    assert chunks[1]["text"] == ", world"
    assert chunks[2]["text"] == "!"
    assert chunks[-1]["finish_reason"] == "stop"
    assert chunks[-1]["prompt_tokens"] == 5
    assert chunks[-1]["completion_tokens"] == 3
    # Request shape sanity.
    assert captured["url"] == (
        "https://llm.api.cloud.yandex.net/foundationModels/v1/completion"
    )
    assert captured["headers"]["authorization"] == "Api-Key test-api-key"
    assert captured["headers"]["x-folder-id"] == "test-folder"
    assert captured["body"]["modelUri"] == (
        "gpt://test-folder/yandexgpt-lite/latest"
    )
    assert captured["body"]["completionOptions"]["stream"] is True
    await provider.close()


async def test_stream_uses_iam_token_when_api_key_absent() -> None:
    s = _make_settings(
        yandex_gpt_api_key=None,
        yandex_iam_token="t1.test-iam",
    )
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["authorization"] = request.headers["authorization"]
        return _stream_response([
            {
                "result": {
                    "alternatives": [{
                        "message": {"role": "assistant", "text": "ok"},
                        "status": "ALTERNATIVE_STATUS_FINAL",
                    }],
                },
            }
        ])

    provider = _build_provider_with_handler(handler, settings=s)
    chunks = await _collect(
        provider.stream_completion([{"role": "user", "content": "x"}])
    )
    assert captured["authorization"] == "Bearer t1.test-iam"
    assert chunks[-1]["finish_reason"] == "stop"
    await provider.close()


async def test_stream_4xx_raises_for_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "unauthorized"})

    provider = _build_provider_with_handler(handler)
    with pytest.raises(httpx.HTTPStatusError):
        await _collect(
            provider.stream_completion(
                [{"role": "user", "content": "hi"}],
            )
        )
    await provider.close()


async def test_tools_raises_not_implemented() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        # Should never be invoked — we raise before hitting the wire.
        return httpx.Response(500)

    provider = _build_provider_with_handler(handler)
    with pytest.raises(NotImplementedError):
        await _collect(
            provider.stream_completion(
                [{"role": "user", "content": "hi"}],
                tools=[{"type": "function", "function": {"name": "x"}}],
            )
        )
    await provider.close()


async def test_already_built_model_uri_passes_through() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return _stream_response([
            {
                "result": {
                    "alternatives": [{
                        "message": {"role": "assistant", "text": "ok"},
                        "status": "ALTERNATIVE_STATUS_FINAL",
                    }],
                },
            }
        ])

    provider = _build_provider_with_handler(handler)
    await _collect(
        provider.stream_completion(
            [{"role": "user", "content": "x"}],
            model="gpt://other-folder/yandexgpt-pro/latest",
        )
    )
    # Pass-through — the adapter must NOT re-prefix a gpt:// URI.
    assert captured["body"]["modelUri"] == (
        "gpt://other-folder/yandexgpt-pro/latest"
    )
    await provider.close()


class _Echo(BaseModel):
    answer: str
    confidence: float


async def test_structured_output_parses_fenced_json() -> None:
    """Model wraps its JSON in ```json fences — adapter strips them."""

    def handler(request: httpx.Request) -> httpx.Response:
        return _stream_response([
            {
                "result": {
                    "alternatives": [{
                        "message": {
                            "role": "assistant",
                            "text": (
                                "```json\n"
                                '{"answer": "yes", "confidence": 0.9}\n'
                                "```"
                            ),
                        },
                        "status": "ALTERNATIVE_STATUS_FINAL",
                    }],
                },
            }
        ])

    provider = _build_provider_with_handler(handler)
    parsed = await provider.structured_output(
        [{"role": "user", "content": "be precise"}], _Echo,
    )
    assert parsed.answer == "yes"
    assert parsed.confidence == pytest.approx(0.9)
    await provider.close()


async def test_structured_output_raises_on_non_json() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return _stream_response([
            {
                "result": {
                    "alternatives": [{
                        "message": {
                            "role": "assistant",
                            "text": "I cannot answer that question.",
                        },
                        "status": "ALTERNATIVE_STATUS_FINAL",
                    }],
                },
            }
        ])

    provider = _build_provider_with_handler(handler)
    with pytest.raises(RuntimeError, match="non-JSON"):
        await provider.structured_output(
            [{"role": "user", "content": "test"}], _Echo,
        )
    await provider.close()


def test_constructor_rejects_missing_folder() -> None:
    """Direct construction (e.g. test scaffolding bypassing Settings)
    should still fail — defence-in-depth alongside the config validator."""
    # Build a Settings that LOOKS valid (openrouter branch passes the
    # validator), then forcibly construct YandexLLMProvider against it.
    s = Settings(
        llm_provider="openrouter",
        openrouter_api_key="sk-x",
        yandex_gpt_folder_id=None,
        yandex_gpt_api_key=None,
        yandex_iam_token=None,
    )
    with pytest.raises(RuntimeError, match="YANDEX_GPT_FOLDER_ID"):
        YandexLLMProvider(s)


def test_constructor_rejects_missing_credentials() -> None:
    s = Settings(
        llm_provider="openrouter",
        openrouter_api_key="sk-x",
        yandex_gpt_folder_id="folder-only",
        yandex_gpt_api_key=None,
        yandex_iam_token=None,
    )
    with pytest.raises(RuntimeError, match="API_KEY or"):
        YandexLLMProvider(s)


def test_default_concurrency_is_conservative() -> None:
    """Default semaphore caps in-flight streams to 2 — fresh Yandex
    Cloud folders only allow ~3-5 RPS on Foundation Models, and we'd
    rather under-utilise than thrash 429s."""
    provider = YandexLLMProvider(_make_settings())
    assert provider._sem._value == 2  # type: ignore[attr-defined]


async def _noop_sleep(_: float) -> None:
    """Replacement for asyncio.sleep in retry tests — must remain async."""
    return None


async def test_stream_retries_on_429_then_succeeds(monkeypatch) -> None:
    """A single 429 on the initial POST is retried transparently and
    the caller eventually consumes the successful stream."""
    monkeypatch.setattr(
        "lectorium_chat.infra.llm_provider.yandex.asyncio.sleep",
        _noop_sleep,
    )
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                429,
                headers={"Retry-After": "0"},
                json={"error": "Too Many Requests"},
            )
        return _stream_response([
            {
                "result": {
                    "alternatives": [{
                        "message": {"role": "assistant", "text": "ok"},
                        "status": "ALTERNATIVE_STATUS_FINAL",
                    }],
                },
            }
        ])

    provider = _build_provider_with_handler(handler)
    chunks = await _collect(
        provider.stream_completion([{"role": "user", "content": "hi"}])
    )
    assert call_count["n"] == 2
    assert chunks[-1]["finish_reason"] == "stop"
    assert "".join(c.get("text", "") for c in chunks) == "ok"
    await provider.close()


async def test_stream_raises_after_max_429s(monkeypatch) -> None:
    """5 consecutive 429s exhaust the retry budget; the HTTPStatusError
    is raised so the caller can surface the throttle to the user."""
    monkeypatch.setattr(
        "lectorium_chat.infra.llm_provider.yandex.asyncio.sleep",
        _noop_sleep,
    )
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        return httpx.Response(
            429,
            headers={"Retry-After": "0"},
            json={"error": "Too Many Requests"},
        )

    provider = _build_provider_with_handler(handler)
    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        await _collect(
            provider.stream_completion([{"role": "user", "content": "hi"}])
        )
    assert excinfo.value.response.status_code == 429
    # 1 initial + 5 retries + 1 final replay for the raise_for_status
    # surface = 7 attempts. (See _stream_with_retry_on_429 docstring.)
    assert call_count["n"] == 7
    await provider.close()


async def test_stream_honors_retry_after_seconds(monkeypatch) -> None:
    """When Retry-After is set (seconds form), sleep that exact value
    rather than the backoff curve."""
    sleeps: list[float] = []

    async def fake_sleep(d: float) -> None:
        sleeps.append(d)

    monkeypatch.setattr(
        "lectorium_chat.infra.llm_provider.yandex.asyncio.sleep",
        fake_sleep,
    )
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                429, headers={"Retry-After": "5"}, json={"error": "x"},
            )
        return _stream_response([
            {
                "result": {
                    "alternatives": [{
                        "message": {"role": "assistant", "text": "ok"},
                        "status": "ALTERNATIVE_STATUS_FINAL",
                    }],
                },
            }
        ])

    provider = _build_provider_with_handler(handler)
    await _collect(
        provider.stream_completion([{"role": "user", "content": "hi"}])
    )
    assert sleeps == [5.0]
    await provider.close()


def test_explicit_concurrency_override() -> None:
    """Operators with bumped Yandex quotas can opt out of the default
    cap by passing concurrency directly at construction time."""
    provider = YandexLLMProvider(_make_settings(), concurrency=10)
    assert provider._sem._value == 10  # type: ignore[attr-defined]
