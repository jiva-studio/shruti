"""Reranker adapters + provider-switch factory.

Mirrors `indexer/embed.py`: a concrete vendor adapter (`VoyageReranker`)
behind a `get_reranker` factory that branches on `rerank_provider`. The
cross-encoder scores each (query, document) pair jointly and returns
`(orig_index, relevance_score)` sorted descending.

`get_reranker` returns None when the provider is "none" OR (for voyage)
the API key is missing — the research pipeline then runs the cosine path
unchanged. So default-on never breaks a keyless deploy.
"""

from __future__ import annotations

import asyncio

import httpx

from lectorium_chat.config import Settings, get_settings
from lectorium_chat.domain.ports.reranker import RerankerPort
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

_RERANKER: RerankerPort | None = None
_RERANKER_BUILT = False  # distinguishes "not built yet" from "built → None"

# Voyage rerank-2 caps query+any single doc at 16K tokens. Truncate each
# document conservatively at ~4 chars/token, leaving headroom for the query.
_MAX_TOTAL_TOKENS = 16_000
_CHARS_PER_TOKEN = 4
_MAX_DOCS = 1000


def _truncate_doc(doc: str, query: str) -> str:
    """Clamp a single document so query+doc stays under the rerank-2 token
    cap. Char-based heuristic (~4 chars/token), deliberately conservative —
    our chunks are far smaller, this only guards a pathological input."""
    budget_tokens = _MAX_TOTAL_TOKENS - (len(query) // _CHARS_PER_TOKEN) - 1
    if budget_tokens <= 0:
        return ""
    max_chars = budget_tokens * _CHARS_PER_TOKEN
    return doc if len(doc) <= max_chars else doc[:max_chars]


class VoyageReranker(RerankerPort):
    """Calls Voyage's /v1/rerank cross-encoder endpoint.

    POST {query, documents, model, top_k} with a Bearer key → response
    `data[]` of `{index, relevance_score}`. `index` points into the
    SUBMITTED documents list, which we return verbatim so callers map
    back to their own pool.
    """

    name = "voyage"

    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        base_url: str | None = None,
        concurrency: int = 2,
        timeout_s: float = 10.0,
    ) -> None:
        self._model = model
        self._api_key = api_key
        self._url = (base_url or "https://api.voyageai.com/v1").rstrip("/") + "/rerank"
        self._timeout_s = timeout_s
        self._sem = asyncio.Semaphore(max(1, concurrency))
        # One pooled client for the reranker's lifetime — a research turn
        # reranks once per fanout round (up to MAX_FANOUT_ROUNDS), so a
        # fresh AsyncClient per call paid a TLS handshake to api.voyageai.com
        # every round. Keep-alive reuse removes that per-round setup cost.
        self._client = httpx.AsyncClient(timeout=self._timeout_s)
        log.info("reranker_loaded", name=self.name, model=model, base_url=base_url)

    async def rerank(
        self,
        query: str,
        documents: list[str],
        *,
        top_k: int | None = None,
    ) -> list[tuple[int, float]]:
        # Reranking 0–1 docs is a no-op (and Voyage needs ≥1 doc); return
        # input order so callers fall through to the identity ordering.
        if len(documents) <= 1:
            return [(i, 0.0) for i in range(len(documents))]

        docs = [_truncate_doc(d, query) for d in documents[:_MAX_DOCS]]
        body: dict = {"query": query, "documents": docs, "model": self._model}
        if top_k is not None:
            body["top_k"] = top_k

        async with self._sem:
            resp = await self._client.post(
                self._url,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json=body,
            )
        resp.raise_for_status()
        data = resp.json().get("data") or []
        scored = [
            (int(item["index"]), float(item["relevance_score"]))
            for item in data
            if "index" in item and "relevance_score" in item
        ]
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored


def get_reranker(settings: Settings | None = None) -> RerankerPort | None:
    global _RERANKER, _RERANKER_BUILT
    if _RERANKER_BUILT:
        return _RERANKER
    s = settings or get_settings()
    _RERANKER = _build_reranker(s)
    _RERANKER_BUILT = True
    return _RERANKER


def _build_reranker(s: Settings) -> RerankerPort | None:
    if s.rerank_provider == "none":
        return None
    if s.rerank_provider == "voyage":
        if not s.voyage_api_key:
            log.warning("reranker_disabled_no_key", provider="voyage")
            return None
        return VoyageReranker(
            model=s.rerank_model,
            api_key=s.voyage_api_key,
            base_url=s.rerank_base_url,
            concurrency=s.rerank_concurrency,
            timeout_s=s.rerank_timeout_s,
        )
    if s.rerank_provider == "tei":
        raise NotImplementedError(
            "rerank_provider='tei' is reserved for a future self-hosted "
            "backend and not implemented yet."
        )
    raise NotImplementedError(f"Rerank provider {s.rerank_provider!r} not implemented.")
