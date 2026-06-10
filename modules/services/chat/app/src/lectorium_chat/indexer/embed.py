"""Embedder abstraction.

Active provider in MVP: OpenAI-compatible API via OpenRouter. No local model,
no torch. Other providers (Yandex, GigaChat, native OpenAI) are scaffolded
but inert until enabled.

Changing the active embedder requires a full reindex of the corpus
(vectors of different models live in incompatible spaces). The indexer
detects mismatch through `chunks.embed_model` and re-embeds.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod

from openai import AsyncOpenAI

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

# OpenRouter intermittently answers /embeddings with HTTP 200 + an empty `data`
# array under sustained load (a soft throttle, NOT a 429 the SDK retries). Retry
# those — and any transient API error — with exponential backoff (2,4,8,16s).
_EMBED_MAX_ATTEMPTS = 5
_EMBED_BACKOFF_S = 2.0

_EMBEDDER: Embedder | None = None  # forward ref via __future__ annotations


class Embedder(ABC):
    """Maps texts → dense vectors of fixed dim."""

    name: str
    dim: int

    @abstractmethod
    async def embed_query(self, text: str) -> list[float]:
        ...

    @abstractmethod
    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        ...


class OpenAICompatEmbedder(Embedder):
    """Calls an OpenAI-compatible /embeddings endpoint.

    Works with:
    - OpenRouter (`base_url=https://openrouter.ai/api/v1`, model=`openai/text-embedding-3-small`)
    - OpenAI directly (`base_url=None`, model=`text-embedding-3-small`)
    """

    def __init__(self, *, name: str, model: str, dim: int,
                 api_key: str, base_url: str | None = None,
                 query_prefix: str = "", doc_prefix: str = "",
                 timeout_s: float = 30.0) -> None:
        self.name = name
        self.dim = dim
        self._model = model
        self._query_prefix = query_prefix
        self._doc_prefix = doc_prefix
        # Explicit timeout: the SDK default is 600s, which would let a
        # hung embedding call outlive the research-stage wait_for budgets.
        # max_retries=2 is the SDK default, pinned here so a version bump
        # can't silently change the retry behaviour the hot path relies on.
        self._client = AsyncOpenAI(
            api_key=api_key, base_url=base_url, timeout=timeout_s, max_retries=2,
        )
        log.info(
            "embedder_loaded", name=name, model=model, dim=dim, base_url=base_url,
            query_prefix=bool(query_prefix), doc_prefix=bool(doc_prefix),
            timeout_s=timeout_s,
        )

    async def _create(self, inp: str | list[str]):
        """Call /embeddings, retrying transient failures with backoff.

        An empty `data` array surfaces as ValueError("No embedding data
        received") from the SDK parser; the SDK's own max_retries only covers
        HTTP errors (429/5xx), not that. Without this, a single soft-throttled
        response aborts a whole index run — so retry it, and any transient
        error, with exponential backoff and let the run ride through.
        """
        last_exc: Exception | None = None
        for attempt in range(_EMBED_MAX_ATTEMPTS):
            try:
                resp = await self._client.embeddings.create(model=self._model, input=inp)
                if not resp.data:
                    raise ValueError("No embedding data received")
                return resp
            except Exception as exc:  # noqa: BLE001 — transient embed failures are retryable
                last_exc = exc
                if attempt == _EMBED_MAX_ATTEMPTS - 1:
                    break
                log.warning("embed_retry", attempt=attempt + 1, error=str(exc)[:120])
                await asyncio.sleep(_EMBED_BACKOFF_S * (2 ** attempt))
        assert last_exc is not None
        raise last_exc

    async def embed_query(self, text: str) -> list[float]:
        inp = f"{self._query_prefix}{text}" if self._query_prefix else text
        resp = await self._create(inp)
        return resp.data[0].embedding

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        # OpenAI/OpenRouter accept a batch in `input`; up to ~2k entries per call.
        # We batch defensively in groups of 96 to avoid token-limit issues.
        BATCH = 96
        out: list[list[float]] = []
        for i in range(0, len(texts), BATCH):
            chunk = texts[i:i + BATCH]
            if self._doc_prefix:
                chunk = [f"{self._doc_prefix}{t}" for t in chunk]
            resp = await self._create(chunk)
            out.extend(d.embedding for d in resp.data)
        return out


def get_embedder(settings: Settings | None = None) -> Embedder:
    global _EMBEDDER
    if _EMBEDDER is not None:
        return _EMBEDDER
    s = settings or get_settings()
    _EMBEDDER = _build_embedder(s)
    return _EMBEDDER


def _build_embedder(s: Settings) -> Embedder:
    if s.embed_provider == "openrouter":
        if not s.openrouter_api_key:
            raise RuntimeError("EMBED_PROVIDER=openrouter requires OPENROUTER_API_KEY")
        return OpenAICompatEmbedder(
            name=s.embed_model,
            model=s.embed_model,
            dim=s.embed_dim,
            api_key=s.openrouter_api_key,
            base_url="https://openrouter.ai/api/v1",
            query_prefix=s.embed_query_prefix,
            doc_prefix=s.embed_doc_prefix,
            timeout_s=s.embed_timeout_s,
        )
    if s.embed_provider == "openai":
        # EMBED_BASE_URL routes to a self-hosted OpenAI-compatible
        # upstream (e.g. the TEI container on RU). When unset we hit
        # api.openai.com — EU's existing behaviour. The api_key is
        # still required by the OpenAI SDK client even for a
        # self-hosted upstream that ignores auth; pass a sentinel
        # when the operator left it blank.
        if not s.openai_api_key and not s.embed_base_url:
            raise RuntimeError(
                "EMBED_PROVIDER=openai requires OPENAI_API_KEY "
                "(or EMBED_BASE_URL for a self-hosted upstream)"
            )
        return OpenAICompatEmbedder(
            name=s.embed_model,
            model=s.embed_model,
            dim=s.embed_dim,
            api_key=s.openai_api_key or "not-needed",
            base_url=s.embed_base_url,
            query_prefix=s.embed_query_prefix,
            doc_prefix=s.embed_doc_prefix,
            timeout_s=s.embed_timeout_s,
        )
    raise NotImplementedError(
        f"Embed provider {s.embed_provider!r} not implemented yet. "
        "Active: openrouter (default), openai."
    )
