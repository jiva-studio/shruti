"""Yandex Foundation Models embedder.

Calls `POST /foundationModels/v1/textEmbedding` once per text — the
endpoint is single-input. We parallelise documents with a small bounded
gather, mirroring the OpenAI-batch approach used by `OpenAICompatEmbedder`
but without the multi-input request shape (Yandex doesn't accept it).

Asymmetric pair (verified against
https://yandex.cloud/ru/docs/foundation-models/concepts/embeddings):
  - `emb://<folder>/text-search-query/latest` for queries
  - `emb://<folder>/text-search-doc/latest` for documents
Both produce vectors of the same dimension; their training objective
maximises query↔doc cosine similarity rather than symmetric similarity,
so mixing the two encoders inside a single index degrades recall.

Auth: Api-Key (`Authorization: Api-Key ...`) OR IAM token
(`Authorization: Bearer ...`). Same precedence as `YandexLLMProvider`.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from lectorium_chat.indexer.embed import Embedder
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


_TEXT_EMBEDDING_URL = (
    "https://llm.api.cloud.yandex.net/foundationModels/v1/textEmbedding"
)


class YandexEmbedder(Embedder):
    def __init__(
        self,
        *,
        folder_id: str,
        api_key: str | None,
        iam_token: str | None,
        doc_model: str,
        query_model: str,
        dim: int,
        concurrency: int = 8,
    ) -> None:
        if not api_key and not iam_token:
            raise RuntimeError(
                "YandexEmbedder requires api_key or iam_token"
            )
        self.name = f"yandex:{doc_model}"
        self.dim = dim
        self._folder = folder_id
        self._doc_model = doc_model
        self._query_model = query_model
        if api_key:
            self._auth_header = f"Api-Key {api_key}"
        else:
            self._auth_header = f"Bearer {iam_token}"
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0),
        )
        # Bound parallelism — the API is single-input per call so a
        # full corpus reindex would otherwise hammer it. Yandex's rate
        # limits aren't publicly fixed; 8 in flight is a conservative
        # starting point matching their typical RPS quota for new folders.
        self._sem = asyncio.Semaphore(concurrency)
        log.info(
            "embedder_loaded",
            name=self.name,
            doc_model=doc_model,
            query_model=query_model,
            dim=dim,
            base_url=_TEXT_EMBEDDING_URL,
        )

    def _build_model_uri(self, model: str) -> str:
        if model.startswith("emb://"):
            return model
        return f"emb://{self._folder}/{model}"

    async def _embed_one(self, text: str, *, model_uri: str) -> list[float]:
        async with self._sem:
            resp = await self._client.post(
                _TEXT_EMBEDDING_URL,
                json={"modelUri": model_uri, "text": text},
                headers={
                    "Authorization": self._auth_header,
                    "x-folder-id": self._folder,
                    "Content-Type": "application/json",
                },
            )
        resp.raise_for_status()
        body: dict[str, Any] = resp.json()
        vec = body.get("embedding") or []
        if not vec:
            raise RuntimeError(
                f"YandexEmbedder: empty embedding returned for {model_uri}"
            )
        return list(vec)

    async def embed_query(self, text: str) -> list[float]:
        return await self._embed_one(
            text, model_uri=self._build_model_uri(self._query_model),
        )

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        model_uri = self._build_model_uri(self._doc_model)
        return await asyncio.gather(
            *(self._embed_one(t, model_uri=model_uri) for t in texts)
        )

    async def close(self) -> None:
        await self._client.aclose()
