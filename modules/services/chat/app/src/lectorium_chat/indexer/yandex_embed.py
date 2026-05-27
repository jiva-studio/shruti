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
import random
from typing import Any

import httpx

from lectorium_chat.indexer.embed import Embedder
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


_TEXT_EMBEDDING_URL = (
    "https://llm.api.cloud.yandex.net/foundationModels/v1/textEmbedding"
)

# Bounded retry on HTTP 429 (Too Many Requests). Yandex's Foundation
# Models RPS quota on a fresh folder is ~3-5/s; bursts above that get
# throttled. We back off exponentially (2 * 2^attempt seconds + jitter),
# honouring a `Retry-After` header if the server sends one, up to
# _MAX_RETRIES attempts. After that we re-raise so the caller (indexer)
# can surface the failure rather than spin forever.
_MAX_RETRIES = 5
_BACKOFF_BASE_SECONDS = 2.0


def _retry_delay(attempt: int, retry_after: str | None) -> float:
    """Compute the sleep before the next retry.

    Honours `Retry-After` (RFC 7231 — seconds value; we ignore the HTTP-date
    form because Yandex always sends seconds in practice). Falls back to
    exponential backoff `_BACKOFF_BASE_SECONDS * 2^attempt` plus uniform
    jitter in [0, 1) to spread concurrent retries.
    """
    if retry_after:
        try:
            return max(float(retry_after), 0.0)
        except ValueError:
            # Non-numeric Retry-After (HTTP-date form) — fall through to backoff.
            pass
    return _BACKOFF_BASE_SECONDS * (2 ** attempt) + random.random()


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
        concurrency: int = 2,
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
        # full corpus reindex would otherwise hammer it. Default 2 keeps
        # a fresh Yandex Cloud folder (typical 3-5 RPS quota) under the
        # limit; operators with bumped quotas raise via
        # EMBED_CONCURRENCY.
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
        # Retry loop on HTTP 429. Other status codes (4xx that isn't 429,
        # 5xx) bubble up immediately — they don't indicate transient
        # throttling and retrying would mask real misconfiguration.
        last_exc: httpx.HTTPStatusError | None = None
        for attempt in range(_MAX_RETRIES + 1):
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
            if resp.status_code == 429:
                try:
                    resp.raise_for_status()
                except httpx.HTTPStatusError as exc:
                    last_exc = exc
                if attempt >= _MAX_RETRIES:
                    log.error(
                        "yandex_embed_throttled_giving_up",
                        model_uri=model_uri,
                        attempts=attempt + 1,
                        retry_after=resp.headers.get("Retry-After"),
                    )
                    assert last_exc is not None
                    raise last_exc
                delay = _retry_delay(attempt, resp.headers.get("Retry-After"))
                log.warning(
                    "yandex_embed_throttled_retrying",
                    model_uri=model_uri,
                    attempt=attempt + 1,
                    max_attempts=_MAX_RETRIES + 1,
                    sleep_seconds=round(delay, 2),
                    retry_after=resp.headers.get("Retry-After"),
                )
                await asyncio.sleep(delay)
                continue
            resp.raise_for_status()
            body: dict[str, Any] = resp.json()
            vec = body.get("embedding") or []
            if not vec:
                raise RuntimeError(
                    f"YandexEmbedder: empty embedding returned for {model_uri}"
                )
            return list(vec)
        # Defensive — the loop always either returns or raises above.
        assert last_exc is not None
        raise last_exc  # pragma: no cover

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
