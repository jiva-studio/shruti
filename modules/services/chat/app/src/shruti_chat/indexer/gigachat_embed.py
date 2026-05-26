"""GigaChat embedder.

Calls `POST /api/v1/embeddings` — same auth flow as the chat-completion
endpoint (OAuth2 client-credentials), batched-input request shape close
to OpenAI's.

Auth: shared with `GigaChatLLMProvider`. We re-implement a small token
cache here instead of sharing state with the LLM adapter — the embedder
runs inside the indexer process which may be the same as the chat
process or split out later (`PR-7d` indexer extraction). Keeping the
auth state local removes a cross-module coupling.

CA path: same handling as `GigaChatLLMProvider` — mount the Russian
Trusted Root CA via `GIGACHAT_CA_PATH` in prod; CI / dev tolerates the
default trust store.
"""

from __future__ import annotations

import asyncio
import base64
import ssl
import time
import uuid
from typing import Any

import httpx

from shruti_chat.indexer.embed import Embedder
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
_EMBEDDINGS_URL = "https://gigachat.devices.sberbank.ru/api/v1/embeddings"


class _AuthCache:
    """OAuth2 client-credentials token cache. Mirror of
    `_GigachatAuthCache` in the LLM adapter, deliberately duplicated to
    keep the indexer free of an LLM-adapter import."""

    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        scope: str,
        http: httpx.AsyncClient,
    ) -> None:
        self._basic = base64.b64encode(
            f"{client_id}:{client_secret}".encode()
        ).decode()
        self._scope = scope
        self._http = http
        self._token: str | None = None
        self._exp: float = 0.0
        self._lock = asyncio.Lock()

    async def token(self) -> str:
        if self._token and time.time() < self._exp - 30:
            return self._token
        async with self._lock:
            if self._token and time.time() < self._exp - 30:
                return self._token
            resp = await self._http.post(
                _AUTH_URL,
                headers={
                    "Authorization": f"Basic {self._basic}",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                    "RqUID": str(uuid.uuid4()),
                },
                data={"scope": self._scope},
            )
            resp.raise_for_status()
            body = resp.json()
            access = body.get("access_token")
            exp_ms = body.get("expires_at")
            if not access or exp_ms is None:
                raise RuntimeError(
                    "gigachat: auth response missing access_token / expires_at"
                )
            self._token = access
            self._exp = float(exp_ms) / 1000.0
            return self._token


class GigaChatEmbedder(Embedder):
    def __init__(
        self,
        *,
        client_id: str,
        client_secret: str,
        scope: str,
        ca_path: str | None,
        model: str,
        dim: int,
        batch_size: int = 96,
    ) -> None:
        self.name = f"gigachat:{model}"
        self.dim = dim
        self._model = model
        self._batch_size = batch_size
        if ca_path:
            verify: ssl.SSLContext | bool = ssl.create_default_context(
                cafile=ca_path,
            )
        else:
            verify = True
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0),
            verify=verify,
        )
        self._auth = _AuthCache(
            client_id=client_id,
            client_secret=client_secret,
            scope=scope,
            http=self._http,
        )
        log.info(
            "embedder_loaded",
            name=self.name,
            model=model,
            dim=dim,
            base_url=_EMBEDDINGS_URL,
        )

    async def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        token = await self._auth.token()
        resp = await self._http.post(
            _EMBEDDINGS_URL,
            json={"model": self._model, "input": texts},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        resp.raise_for_status()
        body: dict[str, Any] = resp.json()
        data = body.get("data") or []
        # The response order matches the request order per the OpenAI
        # contract — GigaChat follows the same convention. Defensive
        # sort on `index` in case that changes upstream.
        data = sorted(data, key=lambda d: d.get("index", 0))
        return [list(d.get("embedding", [])) for d in data]

    async def embed_query(self, text: str) -> list[float]:
        out = await self._embed_batch([text])
        if not out:
            raise RuntimeError("GigaChatEmbedder: empty response for query")
        return out[0]

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        out: list[list[float]] = []
        for i in range(0, len(texts), self._batch_size):
            chunk = texts[i: i + self._batch_size]
            out.extend(await self._embed_batch(chunk))
        return out

    async def close(self) -> None:
        await self._http.aclose()
