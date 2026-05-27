"""Unit tests for `indexer/yandex_embed.py` request/response shape."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from lectorium_chat.indexer.yandex_embed import YandexEmbedder


async def _noop_sleep(_: float) -> None:
    """Replacement for asyncio.sleep in retry tests — must remain async."""
    return None


def _build_embedder_with_handler(handler) -> YandexEmbedder:
    emb = YandexEmbedder(
        folder_id="folder-x",
        api_key="key-x",
        iam_token=None,
        doc_model="text-search-doc/latest",
        query_model="text-search-query/latest",
        dim=256,
        concurrency=4,
    )
    transport = httpx.MockTransport(handler)
    emb._client = httpx.AsyncClient(  # type: ignore[attr-defined]
        transport=transport,
        timeout=httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=5.0),
    )
    return emb


async def test_embed_query_uses_query_model_uri() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        captured["headers"] = dict(request.headers)
        return httpx.Response(
            200,
            json={
                "embedding": [0.1] * 256,
                "numTokens": "3",
                "modelVersion": "v1",
            },
        )

    emb = _build_embedder_with_handler(handler)
    vec = await emb.embed_query("krishna")
    assert len(vec) == 256
    assert vec[0] == pytest.approx(0.1)
    assert captured["body"]["modelUri"] == (
        "emb://folder-x/text-search-query/latest"
    )
    assert captured["body"]["text"] == "krishna"
    assert captured["headers"]["authorization"] == "Api-Key key-x"
    assert captured["headers"]["x-folder-id"] == "folder-x"
    await emb.close()


async def test_embed_documents_uses_doc_model_uri() -> None:
    seen_uris: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen_uris.append(body["modelUri"])
        return httpx.Response(
            200,
            json={"embedding": [0.2] * 256, "numTokens": "1"},
        )

    emb = _build_embedder_with_handler(handler)
    vecs = await emb.embed_documents(["a", "b", "c"])
    assert len(vecs) == 3
    assert all(len(v) == 256 for v in vecs)
    assert set(seen_uris) == {"emb://folder-x/text-search-doc/latest"}
    await emb.close()


async def test_embed_query_empty_response_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embedding": [], "numTokens": "0"})

    emb = _build_embedder_with_handler(handler)
    with pytest.raises(RuntimeError, match="empty embedding"):
        await emb.embed_query("x")
    await emb.close()


def test_construction_requires_credentials() -> None:
    with pytest.raises(RuntimeError, match="api_key or iam_token"):
        YandexEmbedder(
            folder_id="f",
            api_key=None,
            iam_token=None,
            doc_model="text-search-doc/latest",
            query_model="text-search-query/latest",
            dim=256,
        )


def test_default_concurrency_is_conservative() -> None:
    """Fresh Yandex Cloud folders cap at ~3-5 RPS for Foundation Models —
    default semaphore must keep the indexer under that without an explicit
    env override."""
    emb = YandexEmbedder(
        folder_id="f",
        api_key="k",
        iam_token=None,
        doc_model="text-search-doc/latest",
        query_model="text-search-query/latest",
        dim=256,
    )
    # asyncio.Semaphore exposes its initial value via the private
    # `_value` attr — fine for a unit assertion.
    assert emb._sem._value == 2  # type: ignore[attr-defined]


async def test_embed_retries_on_429_then_succeeds(monkeypatch) -> None:
    """A single 429 must be transparently retried and the caller gets
    the eventual successful embedding."""
    monkeypatch.setattr(
        "lectorium_chat.indexer.yandex_embed.asyncio.sleep",
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
        return httpx.Response(
            200, json={"embedding": [0.5] * 256, "numTokens": "1"},
        )

    emb = _build_embedder_with_handler(handler)
    vec = await emb.embed_query("ok-after-retry")
    assert len(vec) == 256
    assert vec[0] == pytest.approx(0.5)
    assert call_count["n"] == 2
    await emb.close()


async def test_embed_raises_after_max_429s(monkeypatch) -> None:
    """5 consecutive 429s exhaust the retry budget; the original
    HTTPStatusError is raised to the caller."""
    monkeypatch.setattr(
        "lectorium_chat.indexer.yandex_embed.asyncio.sleep",
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

    emb = _build_embedder_with_handler(handler)
    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        await emb.embed_query("never-succeeds")
    assert excinfo.value.response.status_code == 429
    # _MAX_RETRIES = 5 → 1 initial + 5 retries = 6 attempts total.
    assert call_count["n"] == 6
    await emb.close()


async def test_embed_honors_retry_after_seconds(monkeypatch) -> None:
    """When the server sends Retry-After in seconds, we should sleep
    that exact value instead of the backoff curve."""
    sleeps: list[float] = []

    async def fake_sleep(d: float) -> None:
        sleeps.append(d)

    monkeypatch.setattr(
        "lectorium_chat.indexer.yandex_embed.asyncio.sleep", fake_sleep,
    )
    call_count = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return httpx.Response(
                429, headers={"Retry-After": "7"}, json={"error": "x"},
            )
        return httpx.Response(
            200, json={"embedding": [0.1] * 256, "numTokens": "1"},
        )

    emb = _build_embedder_with_handler(handler)
    await emb.embed_query("retry-after-test")
    assert sleeps == [7.0]
    await emb.close()
