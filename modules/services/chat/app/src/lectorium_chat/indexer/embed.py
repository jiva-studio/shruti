"""Embedder abstraction.

Active provider in MVP: OpenAI-compatible API via OpenRouter. No local model,
no torch. Other providers (Yandex, GigaChat, native OpenAI) are scaffolded
but inert until enabled.

Changing the active embedder requires a full reindex of the corpus
(vectors of different models live in incompatible spaces). The indexer
detects mismatch through `chunks.embed_model` and re-embeds.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from openai import AsyncOpenAI

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

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
                 api_key: str, base_url: str | None = None) -> None:
        self.name = name
        self.dim = dim
        self._model = model
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url)
        log.info("embedder_loaded", name=name, model=model, dim=dim, base_url=base_url)

    async def embed_query(self, text: str) -> list[float]:
        resp = await self._client.embeddings.create(model=self._model, input=text)
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
            resp = await self._client.embeddings.create(
                model=self._model, input=chunk,
            )
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
        )
    if s.embed_provider == "openai":
        if not s.openai_api_key:
            raise RuntimeError("EMBED_PROVIDER=openai requires OPENAI_API_KEY")
        return OpenAICompatEmbedder(
            name=s.embed_model,
            model=s.embed_model,
            dim=s.embed_dim,
            api_key=s.openai_api_key,
            base_url=None,
        )
    raise NotImplementedError(
        f"Embed provider {s.embed_provider!r} not implemented yet. "
        "Active in MVP: openrouter (default) and openai."
    )
