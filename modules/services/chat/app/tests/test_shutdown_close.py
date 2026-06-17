"""Shutdown teardown closes the Redis-backed stores + reranker client.

The lifespan `finally` block routes the idempotency store, turn store,
and reranker through `_close_quietly`, which must:

  - call the first available close method (`close` preferred, `aclose`
    fallback), awaiting coroutine results;
  - never raise when the object is None, lacks a close method, or its
    close raises — a leaked-connection cleanup must not abort the rest
    of the shutdown sequence.

This guards the bug where these three clients were never closed on
redeploy, leaking Redis connections and the keep-alive httpx pool.
"""

from __future__ import annotations

import pytest

from shruti_chat.main import _close_quietly


class _AsyncClose:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class _AsyncAclose:
    def __init__(self) -> None:
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class _SyncClose:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _Raises:
    async def close(self) -> None:
        raise RuntimeError("boom")


class _NoCloseMethod:
    pass


@pytest.mark.asyncio
async def test_calls_async_close() -> None:
    obj = _AsyncClose()
    await _close_quietly(obj, "close", "aclose")
    assert obj.closed is True


@pytest.mark.asyncio
async def test_falls_back_to_aclose() -> None:
    obj = _AsyncAclose()
    await _close_quietly(obj, "close", "aclose")
    assert obj.closed is True


@pytest.mark.asyncio
async def test_calls_sync_close() -> None:
    obj = _SyncClose()
    await _close_quietly(obj, "close", "aclose")
    assert obj.closed is True


@pytest.mark.asyncio
async def test_none_object_is_noop() -> None:
    # No-op stores can be wired in as None (e.g. reranker disabled).
    await _close_quietly(None, "close", "aclose")


@pytest.mark.asyncio
async def test_missing_method_is_noop() -> None:
    await _close_quietly(_NoCloseMethod(), "close", "aclose")


@pytest.mark.asyncio
async def test_close_error_is_swallowed() -> None:
    # A failing close must not propagate and abort shutdown.
    await _close_quietly(_Raises(), "close", "aclose")


@pytest.mark.asyncio
async def test_reranker_close_closes_pooled_client() -> None:
    # VoyageReranker.close() must aclose the pooled httpx client so the
    # keep-alive connection to api.voyageai.com is released on shutdown.
    from shruti_chat.infra.rerank import VoyageReranker

    rr = VoyageReranker(model="rerank-2", api_key="k")
    closed = {"n": 0}

    async def _fake_aclose() -> None:
        closed["n"] += 1

    rr._client.aclose = _fake_aclose  # type: ignore[method-assign]
    await _close_quietly(rr, "close", "aclose")
    assert closed["n"] == 1


def test_cors_exposes_rate_limit_headers() -> None:
    # The 429 envelope (api/_rate_limit.py) emits X-RateLimit-*; CORS must
    # expose them so the cross-origin WebView can read them off the 429.
    from fastapi.middleware.cors import CORSMiddleware

    from shruti_chat.main import app

    cors = next(
        m for m in app.user_middleware if m.cls is CORSMiddleware
    )
    exposed = cors.kwargs["expose_headers"]
    for h in ("X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"):
        assert h in exposed, f"{h} not exposed via CORS"
