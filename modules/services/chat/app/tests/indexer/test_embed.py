"""Unit tests for indexer.embed.OpenAICompatEmbedder._create / embed_documents.

Covers the resilience hardening:
  * a permanent 4xx (input-too-long / bad key) is NOT retried — degradation
    happens on the FIRST attempt instead of after the full backoff ladder;
  * a transient error IS still retried (regression guard);
  * a per-batch vector-count mismatch raises (a misaligned response must not
    silently attach the wrong vector to a chunk).

The OpenAI HTTP layer is faked at the `embeddings.create` boundary, so no
network and no real SDK error construction is needed — the embedder only
reads `.status_code` / the exception type and `resp.data`.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from lectorium_chat.indexer import embed as embed_mod
from lectorium_chat.indexer.embed import OpenAICompatEmbedder


class _StatusError(Exception):
    """Quacks like the openai SDK's APIStatusError — only `status_code`
    matters to `_is_non_retryable`."""

    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status_code = status


def _embedding_obj(vec: list[float], index: int) -> Any:
    return SimpleNamespace(embedding=vec, index=index)


def _resp(vecs: list[list[float]]) -> Any:
    return SimpleNamespace(data=[_embedding_obj(v, i) for i, v in enumerate(vecs)])


class _FakeEmbeddings:
    """Records every create() call; returns scripted responses / raises."""

    def __init__(self, behaviour) -> None:
        self._behaviour = behaviour
        self.calls = 0

    async def create(self, *, model: str, input):  # noqa: A002 — SDK param name
        self.calls += 1
        result = self._behaviour(self.calls, input)
        if isinstance(result, Exception):
            raise result
        return result


def _make_embedder(behaviour) -> tuple[OpenAICompatEmbedder, _FakeEmbeddings]:
    emb = OpenAICompatEmbedder(
        name="fake", model="fake-model", dim=4, api_key="k",
    )
    fake = _FakeEmbeddings(behaviour)
    emb._client = SimpleNamespace(embeddings=fake)  # type: ignore[attr-defined]
    return emb, fake


# ---- #2: no retry on 4xx --------------------------------------------------


async def test_bad_request_not_retried(monkeypatch):
    # Make backoff a no-op so an accidental retry wouldn't slow the test —
    # we assert on call count, not wall time.
    monkeypatch.setattr(embed_mod.asyncio, "sleep", _noop_sleep)
    emb, fake = _make_embedder(lambda call, inp: _StatusError(400))
    with pytest.raises(_StatusError):
        await emb.embed_query("too long input")
    assert fake.calls == 1  # raised immediately, no backoff ladder


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
async def test_client_errors_not_retried(monkeypatch, status):
    monkeypatch.setattr(embed_mod.asyncio, "sleep", _noop_sleep)
    emb, fake = _make_embedder(lambda call, inp: _StatusError(status))
    with pytest.raises(_StatusError):
        await emb.embed_query("x")
    assert fake.calls == 1


async def test_transient_error_is_still_retried(monkeypatch):
    # A 429 (rate limit) IS transient — the retry ladder must still cover it.
    sleeps: list[float] = []

    async def _record_sleep(s: float) -> None:
        sleeps.append(s)

    monkeypatch.setattr(embed_mod.asyncio, "sleep", _record_sleep)
    emb, fake = _make_embedder(lambda call, inp: _StatusError(429))
    with pytest.raises(_StatusError):
        await emb.embed_query("x")
    assert fake.calls == embed_mod._EMBED_MAX_ATTEMPTS
    assert len(sleeps) == embed_mod._EMBED_MAX_ATTEMPTS - 1


async def test_transient_then_success(monkeypatch):
    monkeypatch.setattr(embed_mod.asyncio, "sleep", _noop_sleep)

    def _behaviour(call: int, inp):
        if call == 1:
            return _StatusError(503)  # transient → retried
        return _resp([[0.1, 0.2, 0.3, 0.4]])

    emb, fake = _make_embedder(_behaviour)
    out = await emb.embed_query("x")
    assert out == [0.1, 0.2, 0.3, 0.4]
    assert fake.calls == 2


# ---- #3: per-batch count mismatch guard -----------------------------------


async def test_embed_documents_count_mismatch_raises(monkeypatch):
    monkeypatch.setattr(embed_mod.asyncio, "sleep", _noop_sleep)
    # Sent 2 inputs, provider returns 1 vector → misaligned mapping.
    emb, _ = _make_embedder(lambda call, inp: _resp([[0.0] * 4]))
    with pytest.raises(ValueError, match="batch size mismatch"):
        await emb.embed_documents(["a", "b"])


async def test_embed_documents_reorders_by_index(monkeypatch):
    monkeypatch.setattr(embed_mod.asyncio, "sleep", _noop_sleep)

    def _behaviour(call: int, inp):
        # Return the two vectors in REVERSE wire order with explicit indices;
        # the embedder must re-order by `index` so vector for input 0 comes
        # first.
        return SimpleNamespace(data=[
            _embedding_obj([1.0] * 4, 1),
            _embedding_obj([0.0] * 4, 0),
        ])

    emb, _ = _make_embedder(_behaviour)
    out = await emb.embed_documents(["a", "b"])
    assert out == [[0.0] * 4, [1.0] * 4]


async def test_embed_documents_happy_path(monkeypatch):
    monkeypatch.setattr(embed_mod.asyncio, "sleep", _noop_sleep)
    emb, fake = _make_embedder(lambda call, inp: _resp([[float(i)] * 4 for i in range(len(inp))]))
    out = await emb.embed_documents(["a", "b", "c"])
    assert out == [[0.0] * 4, [1.0] * 4, [2.0] * 4]
    assert fake.calls == 1


async def _noop_sleep(_s: float) -> None:
    return None
