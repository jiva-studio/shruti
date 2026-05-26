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
    if s.embed_provider == "yandex":
        # Yandex Foundation Models exposes an asymmetric pair —
        # `text-search-query/latest` for queries, `text-search-doc/latest`
        # for documents. Both must use the same dim (s.embed_dim). The
        # auth + folder share Settings with the LLM adapter, falling
        # back to the dedicated embed-* fields if those are split out.
        from lectorium_chat.indexer.yandex_embed import YandexEmbedder

        folder = s.yandex_embed_folder_id or s.yandex_gpt_folder_id
        api_key = s.yandex_embed_api_key or s.yandex_gpt_api_key
        if not folder:
            raise RuntimeError(
                "EMBED_PROVIDER=yandex requires YANDEX_EMBED_FOLDER_ID "
                "or YANDEX_GPT_FOLDER_ID"
            )
        if not api_key and not s.yandex_iam_token:
            raise RuntimeError(
                "EMBED_PROVIDER=yandex requires YANDEX_EMBED_API_KEY / "
                "YANDEX_GPT_API_KEY or YANDEX_IAM_TOKEN"
            )
        return YandexEmbedder(
            folder_id=folder,
            api_key=api_key,
            iam_token=s.yandex_iam_token,
            doc_model=s.embed_model or "text-search-doc/latest",
            query_model=s.embed_query_model or "text-search-query/latest",
            dim=s.embed_dim,
        )
    if s.embed_provider == "gigachat":
        from lectorium_chat.indexer.gigachat_embed import GigaChatEmbedder

        # GigaChat's embeddings endpoint shares the OAuth2 auth flow with
        # the chat-completions endpoint — same client_id/secret/scope.
        # The legacy `gigachat_embed_api_key` is a placeholder from the
        # litellm-era config; not used by the new adapter.
        if not s.gigachat_client_id or not s.gigachat_client_secret:
            raise RuntimeError(
                "EMBED_PROVIDER=gigachat requires GIGACHAT_CLIENT_ID and "
                "GIGACHAT_CLIENT_SECRET"
            )
        return GigaChatEmbedder(
            client_id=s.gigachat_client_id,
            client_secret=s.gigachat_client_secret,
            scope=s.gigachat_scope,
            ca_path=s.gigachat_ca_path,
            model=s.embed_model or "EmbeddingsGigaR",
            dim=s.embed_dim,
        )
    raise NotImplementedError(
        f"Embed provider {s.embed_provider!r} not implemented yet. "
        "Active: openrouter (default), openai, yandex, gigachat."
    )
