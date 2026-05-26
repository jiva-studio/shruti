"""Unit tests for `indexer/gigachat_embed.py` request/response shape."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
import pytest

from lectorium_chat.indexer.gigachat_embed import GigaChatEmbedder, _AuthCache


def _build_embedder_with_handler(handler) -> GigaChatEmbedder:
    emb = GigaChatEmbedder(
        client_id="id-x",
        client_secret="secret-x",
        scope="GIGACHAT_API_PERS",
        ca_path=None,
        model="EmbeddingsGigaR",
        dim=1024,
        batch_size=4,
    )
    transport = httpx.MockTransport(handler)
    emb._http = httpx.AsyncClient(  # type: ignore[attr-defined]
        transport=transport,
        timeout=httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=5.0),
    )
    emb._auth = _AuthCache(  # type: ignore[attr-defined]
        client_id="id-x",
        client_secret="secret-x",
        scope="GIGACHAT_API_PERS",
        http=emb._http,  # type: ignore[attr-defined]
    )
    return emb


async def test_embed_query_oauth_then_post() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v2/oauth":
            return httpx.Response(
                200,
                json={
                    "access_token": "tk-1",
                    "expires_at": int((time.time() + 300) * 1000),
                },
            )
        captured["body"] = json.loads(request.content)
        captured["auth"] = request.headers["authorization"]
        return httpx.Response(
            200,
            json={
                "data": [{"index": 0, "embedding": [0.5] * 1024}],
                "model": "EmbeddingsGigaR",
            },
        )

    emb = _build_embedder_with_handler(handler)
    vec = await emb.embed_query("test")
    assert len(vec) == 1024
    assert vec[0] == pytest.approx(0.5)
    assert captured["body"]["model"] == "EmbeddingsGigaR"
    assert captured["body"]["input"] == ["test"]
    assert captured["auth"] == "Bearer tk-1"
    await emb.close()


async def test_embed_documents_batches_and_preserves_order() -> None:
    """Batch_size=4; ten texts → three batches; output order matches input."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v2/oauth":
            return httpx.Response(
                200,
                json={
                    "access_token": "tk-1",
                    "expires_at": int((time.time() + 300) * 1000),
                },
            )
        body = json.loads(request.content)
        inp = body["input"]
        # Fake response with index out-of-order to validate the sort.
        data = [
            {"index": i, "embedding": [float(i)] * 1024}
            for i in range(len(inp))
        ]
        # Reverse the data array so the adapter HAS to re-sort by index.
        data.reverse()
        return httpx.Response(200, json={"data": data})

    emb = _build_embedder_with_handler(handler)
    vecs = await emb.embed_documents([f"t{i}" for i in range(10)])
    assert len(vecs) == 10
    assert vecs[0][0] == 0.0
    assert vecs[3][0] == 3.0
    assert vecs[9][0] == 1.0  # index 9 % 4 = 1 inside the third batch
    await emb.close()


async def test_embed_query_empty_response_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v2/oauth":
            return httpx.Response(
                200,
                json={
                    "access_token": "tk-1",
                    "expires_at": int((time.time() + 300) * 1000),
                },
            )
        return httpx.Response(200, json={"data": []})

    emb = _build_embedder_with_handler(handler)
    with pytest.raises(RuntimeError, match="empty response"):
        await emb.embed_query("x")
    await emb.close()
