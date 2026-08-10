"""Unit tests for infra.rerank — VoyageReranker + get_reranker factory.

The HTTP layer is mocked at the httpx.AsyncClient.post boundary so we
assert on the request body (truncation, top_k) and the index mapping of
the parsed response without a network call.
"""

from __future__ import annotations

from types import SimpleNamespace  # noqa: F401
from typing import Any

import httpx
import pytest

from shruti_chat.config import Settings
from shruti_chat.infra import rerank as rerank_mod
from shruti_chat.infra.rerank import (
    RerankerUnavailable,
    VoyageReranker,
    _truncate_doc,
    get_reranker,
)


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
    # <=1 doc: identity ordering and NO HTTP POST. The client is pooled
    # (built once at init), so the invariant is "no network call", not
    # "no client constructed".
    constructed = {"n": 0}
    client = _FakeAsyncClient({"data": []})

    def _factory(*a, **k):
        constructed["n"] += 1
        return client

    monkeypatch.setattr(rerank_mod.httpx, "AsyncClient", _factory)
    rr = VoyageReranker(model="rerank-2", api_key="k")
    assert await rr.rerank("q", ["only"]) == [(0, 0.0)]
    assert await rr.rerank("q", []) == []
    assert client.posts == []        # no network call for <=1 doc
    assert constructed["n"] == 1     # pooled: client built once at init


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


# ---- circuit breaker -----------------------------------------------------


class _FailingClient:
    """httpx stand-in that always fails, counting the attempts that got through."""

    def __init__(self) -> None:
        self.calls = 0

    async def post(self, *a, **kw):
        self.calls += 1
        raise httpx.ConnectError("voyage down")

    async def aclose(self) -> None:
        return None


def _breaker_reranker(threshold: int = 3, open_s: float = 30.0) -> VoyageReranker:
    r = VoyageReranker(
        model="rerank-2", api_key="k",
        circuit_threshold=threshold, circuit_open_s=open_s,
    )
    r._client = _FailingClient()
    return r


@pytest.mark.asyncio
async def test_circuit_opens_after_repeated_failures() -> None:
    """Every call site already degrades to cosine on an exception, so an
    outage was correct — it just cost a full timeout on every rerank of every
    turn first. Past the threshold the calls must fail without leaving the
    process."""
    r = _breaker_reranker(threshold=3)
    docs = ["a", "b"]

    for _ in range(3):
        with pytest.raises(httpx.ConnectError):
            await r.rerank("q", docs)
    assert r._client.calls == 3

    # Circuit is open: no further provider calls, and a distinct error type.
    with pytest.raises(RerankerUnavailable):
        await r.rerank("q", docs)
    assert r._client.calls == 3


@pytest.mark.asyncio
async def test_circuit_reopens_after_the_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = {"t": 1000.0}
    monkeypatch.setattr(rerank_mod, "monotonic", lambda: clock["t"])
    r = _breaker_reranker(threshold=1, open_s=30.0)
    docs = ["a", "b"]

    with pytest.raises(httpx.ConnectError):
        await r.rerank("q", docs)
    with pytest.raises(RerankerUnavailable):
        await r.rerank("q", docs)

    clock["t"] += 30.1
    # Half-open: the next call probes the provider again.
    with pytest.raises(httpx.ConnectError):
        await r.rerank("q", docs)
    assert r._client.calls == 2


@pytest.mark.asyncio
async def test_a_success_clears_the_failure_run() -> None:
    r = _breaker_reranker(threshold=3)
    docs = ["a", "b"]

    with pytest.raises(httpx.ConnectError):
        await r.rerank("q", docs)
    assert r._consecutive_failures == 1

    r._record_success()
    assert r._consecutive_failures == 0
    assert r._open_until == 0.0
