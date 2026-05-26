"""Tests for `infra/llm_provider/gigachat.py`.

Mirrors the Yandex test pattern: build the adapter, swap its internal
httpx client for one wired to a MockTransport, drive it.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from shruti_chat.config import Settings
from shruti_chat.infra.llm_provider.gigachat import (
    GigaChatLLMProvider,
    _GigachatAuthCache,
)


def _make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "llm_provider": "gigachat",
        "gigachat_client_id": "test-id",
        "gigachat_client_secret": "test-secret",
        "gigachat_scope": "GIGACHAT_API_PERS",
        "llm_default": "GigaChat",
        "stage_timing_enabled": False,
        "indexer_bootstrap_on_start": False,
    }
    base.update(overrides)
    return Settings(**base)


def _build_provider_with_handler(
    handler, settings: Settings | None = None,
) -> GigaChatLLMProvider:
    s = settings or _make_settings()
    provider = GigaChatLLMProvider(s)
    transport = httpx.MockTransport(handler)
    provider._http = httpx.AsyncClient(  # type: ignore[attr-defined]
        transport=transport,
        timeout=httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=5.0),
    )
    # The auth cache holds a back-reference to the old client — swap it
    # too so OAuth requests go through the mock.
    provider._auth = _GigachatAuthCache(  # type: ignore[attr-defined]
        client_id="test-id",
        client_secret="test-secret",
        scope="GIGACHAT_API_PERS",
        http=provider._http,  # type: ignore[attr-defined]
    )
    return provider


def _sse_body(events: list[str]) -> bytes:
    return ("\n".join(f"data: {e}" for e in events) + "\n").encode("utf-8")


async def _collect(it: AsyncIterator[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    async for c in it:
        out.append(dict(c))
    return out


async def test_oauth_token_fetched_then_cached() -> None:
    """First call fetches a token; second call within TTL reuses it."""
    auth_hits = 0
    completion_hits = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal auth_hits, completion_hits
        if request.url.path == "/api/v2/oauth":
            auth_hits += 1
            return httpx.Response(
                200,
                json={
                    "access_token": "tk-1",
                    "expires_at": int((time.time() + 600) * 1000),
                },
            )
        completion_hits += 1
        return httpx.Response(
            200,
            content=_sse_body([
                json.dumps({
                    "choices": [{
                        "delta": {"content": "hi"},
                        "finish_reason": None,
                    }],
                }),
                json.dumps({
                    "choices": [{
                        "delta": {},
                        "finish_reason": "stop",
                    }],
                }),
                "[DONE]",
            ]),
            headers={"content-type": "text/event-stream"},
        )

    provider = _build_provider_with_handler(handler)
    chunks = await _collect(
        provider.stream_completion([{"role": "user", "content": "hi"}])
    )
    assert chunks[0]["text"] == "hi"
    assert chunks[-1]["finish_reason"] == "stop"
    # Second call — token cache hit, only completion endpoint hit again.
    await _collect(
        provider.stream_completion([{"role": "user", "content": "hi 2"}])
    )
    assert auth_hits == 1
    assert completion_hits == 2
    await provider.close()


async def test_completion_streams_text_and_finish_reason() -> None:
    captured_completion: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v2/oauth":
            return httpx.Response(
                200,
                json={
                    "access_token": "tk-1",
                    "expires_at": int((time.time() + 600) * 1000),
                },
            )
        captured_completion["body"] = json.loads(request.content)
        captured_completion["auth"] = request.headers["authorization"]
        return httpx.Response(
            200,
            content=_sse_body([
                json.dumps({"choices": [{"delta": {"content": "Hel"}}]}),
                json.dumps({"choices": [{"delta": {"content": "lo!"}}]}),
                json.dumps({
                    "choices": [{"delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 4, "completion_tokens": 2},
                }),
                "[DONE]",
            ]),
            headers={"content-type": "text/event-stream"},
        )

    provider = _build_provider_with_handler(handler)
    chunks = await _collect(
        provider.stream_completion(
            [{"role": "user", "content": "say hi"}],
            model="GigaChat-Pro",
            temperature=0.5,
        )
    )
    assert "".join(c.get("text", "") for c in chunks) == "Hello!"
    assert chunks[-1]["finish_reason"] == "stop"
    assert chunks[-1]["prompt_tokens"] == 4
    assert chunks[-1]["completion_tokens"] == 2
    assert captured_completion["body"]["model"] == "GigaChat-Pro"
    assert captured_completion["body"]["temperature"] == 0.5
    assert captured_completion["body"]["stream"] is True
    assert captured_completion["auth"] == "Bearer tk-1"
    await provider.close()


async def test_function_call_shape_produces_tool_calls_delta() -> None:
    """Legacy `function_call` shape → `tool_calls` deltas."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v2/oauth":
            return httpx.Response(
                200,
                json={
                    "access_token": "tk-1",
                    "expires_at": int((time.time() + 600) * 1000),
                },
            )
        return httpx.Response(
            200,
            content=_sse_body([
                # First chunk: function name.
                json.dumps({
                    "choices": [{
                        "delta": {
                            "function_call": {
                                "name": "chunks_search",
                                "arguments": "",
                            },
                        },
                    }],
                }),
                # Second chunk: arguments JSON streamed in.
                json.dumps({
                    "choices": [{
                        "delta": {
                            "function_call": {
                                "arguments": '{"q":"krishna"}',
                            },
                        },
                    }],
                }),
                # Finalisation.
                json.dumps({
                    "choices": [{
                        "delta": {},
                        "finish_reason": "function_call",
                    }],
                }),
                "[DONE]",
            ]),
            headers={"content-type": "text/event-stream"},
        )

    provider = _build_provider_with_handler(handler)
    chunks = await _collect(
        provider.stream_completion(
            [{"role": "user", "content": "find krishna"}],
            tools=[{
                "type": "function",
                "function": {
                    "name": "chunks_search",
                    "description": "search",
                    "parameters": {"type": "object", "properties": {}},
                },
            }],
            tool_choice="chunks_search",
        )
    )
    tool_chunks = [c for c in chunks if "tool_calls" in c]
    assert len(tool_chunks) == 2
    first = tool_chunks[0]["tool_calls"][0]
    second = tool_chunks[1]["tool_calls"][0]
    assert first["name"] == "chunks_search"
    assert first["index"] == 0
    assert "id" in first  # synthesised by adapter
    assert second["arguments_delta"] == '{"q":"krishna"}'
    assert chunks[-1]["finish_reason"] == "function_call"
    await provider.close()


async def test_auth_failure_propagates() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v2/oauth":
            return httpx.Response(401, json={"error": "bad creds"})
        return httpx.Response(500)  # pragma: no cover

    provider = _build_provider_with_handler(handler)
    with pytest.raises(httpx.HTTPStatusError):
        await _collect(
            provider.stream_completion([{"role": "user", "content": "x"}])
        )
    await provider.close()


async def test_auth_response_missing_token_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v2/oauth":
            return httpx.Response(200, json={"oops": "no token"})
        return httpx.Response(500)  # pragma: no cover

    provider = _build_provider_with_handler(handler)
    with pytest.raises(RuntimeError, match="access_token"):
        await _collect(
            provider.stream_completion([{"role": "user", "content": "x"}])
        )
    await provider.close()


async def test_constructor_rejects_missing_credentials() -> None:
    # Build a Settings via the openrouter branch to bypass the gigachat
    # validator, then directly construct GigaChatLLMProvider — same
    # defence-in-depth check as the Yandex test.
    s = Settings(
        llm_provider="openrouter",
        openrouter_api_key="sk-x",
        gigachat_client_id=None,
        gigachat_client_secret=None,
    )
    with pytest.raises(RuntimeError, match="GIGACHAT_CLIENT_ID"):
        GigaChatLLMProvider(s)
