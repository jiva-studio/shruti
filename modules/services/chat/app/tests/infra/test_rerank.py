"""Unit tests for infra.rerank — VoyageReranker + get_reranker factory.

The HTTP layer is mocked at the httpx.AsyncClient.post boundary so we
assert on the request body (truncation, top_k) and the index mapping of
the parsed response without a network call.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from shruti_chat.config import Settings
from shruti_chat.infra import rerank as rerank_mod
from shruti_chat.infra.rerank import VoyageReranker, _truncate_doc, get_reranker


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.captured: dict[str, Any] = {}

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeAsyncClient:
    """Stand-in for httpx.AsyncClient capturing the POST body/headers."""

    last_instance: "_FakeAsyncClient | None" = None

    def __init__(self, payload: dict[str, Any], *, timeout: float | None = None) -> None:
        self._payload = payload
        self.timeout = timeout
        self.posts: list[dict[str, Any]] = []
        _FakeAsyncClient.last_instance = self

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def post(self, url: str, *, headers: dict[str, str], json: dict[str, Any]):
        self.posts.append({"url": url, "headers": headers, "json": json})
        return _FakeResponse(self._payload)


def _patch_client(monkeypatch, payload: dict[str, Any]) -> None:
    def _factory(*args, **kwargs):
        return _FakeAsyncClient(payload, timeout=kwargs.get("timeout"))

    monkeypatch.setattr(rerank_mod.httpx, "AsyncClient", _factory)


@pytest.mark.asyncio
async def test_rerank_maps_response_index_to_submitted_order(monkeypatch):
    # Voyage returns data sorted however it likes; `index` points into the
    # submitted documents list. We must return (orig_index, score) sorted
    # desc by score.
    payload = {
        "data": [
            {"index": 2, "relevance_score": 0.9},
            {"index": 0, "relevance_score": 0.3},
            {"index": 1, "relevance_score": 0.7},
        ]
    }
    _patch_client(monkeypatch, payload)
    rr = VoyageReranker(model="rerank-2", api_key="k")
    out = await rr.rerank("q", ["a", "b", "c"])
    assert out == [(2, 0.9), (1, 0.7), (0, 0.3)]


@pytest.mark.asyncio
async def test_rerank_sends_top_k_and_auth_header(monkeypatch):
    payload = {"data": [{"index": 0, "relevance_score": 0.5}, {"index": 1, "relevance_score": 0.4}]}
    _patch_client(monkeypatch, payload)
    rr = VoyageReranker(model="rerank-2", api_key="secret-key")
    await rr.rerank("q", ["a", "b"], top_k=1)
    post = _FakeAsyncClient.last_instance.posts[0]
    assert post["url"].endswith("/v1/rerank")
    assert post["headers"]["Authorization"] == "Bearer secret-key"
    assert post["json"]["query"] == "q"
    assert post["json"]["model"] == "rerank-2"
    assert post["json"]["top_k"] == 1
    assert post["json"]["documents"] == ["a", "b"]


@pytest.mark.asyncio
async def test_rerank_truncates_oversize_document(monkeypatch):
    payload = {"data": [{"index": 0, "relevance_score": 0.5}, {"index": 1, "relevance_score": 0.4}]}
    _patch_client(monkeypatch, payload)
    rr = VoyageReranker(model="rerank-2", api_key="k")
    huge = "x" * 200_000  # well over the 16K-token (~64K char) budget
    await rr.rerank("q", [huge, "small"])
    sent = _FakeAsyncClient.last_instance.posts[0]["json"]["documents"]
    # The oversize doc is clamped; the small one is untouched.
    assert len(sent[0]) < len(huge)
    assert sent[1] == "small"


@pytest.mark.asyncio
async def test_rerank_noop_for_single_doc(monkeypatch):
    # <=1 doc: no HTTP call, identity ordering returned.
    called = {"n": 0}

    def _factory(*a, **k):
        called["n"] += 1
        return _FakeAsyncClient({"data": []})

    monkeypatch.setattr(rerank_mod.httpx, "AsyncClient", _factory)
    rr = VoyageReranker(model="rerank-2", api_key="k")
    assert await rr.rerank("q", ["only"]) == [(0, 0.0)]
    assert await rr.rerank("q", []) == []
    assert called["n"] == 0


def test_truncate_doc_keeps_short_text():
    assert _truncate_doc("hello", "q") == "hello"


def test_truncate_doc_clamps_long_text():
    long = "y" * 100_000
    out = _truncate_doc(long, "q")
    assert len(out) < len(long)


def _settings(**over) -> Settings:
    base = dict(
        rerank_provider="voyage",
        voyage_api_key=None,
        rerank_model="rerank-2",
    )
    base.update(over)
    return Settings(**base)


def test_get_reranker_none_when_provider_none():
    rerank_mod._RERANKER = None
    rerank_mod._RERANKER_BUILT = False
    assert get_reranker(_settings(rerank_provider="none")) is None


def test_get_reranker_none_when_key_missing(caplog):
    rerank_mod._RERANKER = None
    rerank_mod._RERANKER_BUILT = False
    assert get_reranker(_settings(rerank_provider="voyage", voyage_api_key=None)) is None


def test_get_reranker_builds_voyage_with_key():
    rerank_mod._RERANKER = None
    rerank_mod._RERANKER_BUILT = False
    rr = get_reranker(_settings(rerank_provider="voyage", voyage_api_key="k"))
    assert isinstance(rr, VoyageReranker)
    assert rr.name == "voyage"
    # Reset the module singleton so other tests build fresh.
    rerank_mod._RERANKER = None
    rerank_mod._RERANKER_BUILT = False


def test_get_reranker_tei_not_implemented():
    rerank_mod._RERANKER = None
    rerank_mod._RERANKER_BUILT = False
    with pytest.raises(NotImplementedError):
        get_reranker(_settings(rerank_provider="tei"))
    rerank_mod._RERANKER = None
    rerank_mod._RERANKER_BUILT = False
