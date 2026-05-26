"""Unit tests for `indexer/yandex_embed.py` request/response shape."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from shruti_chat.indexer.yandex_embed import YandexEmbedder


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
