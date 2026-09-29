"""Bunny Edge Storage adapter.

Objects are GET/PUT at `{endpoint}/{zone}/{key}` with an `AccessKey:
<storage-zone password>` header. A 404 means absent; any other non-success
status raises `httpx.HTTPStatusError`.

The storage API keeps no per-object headers besides the content type, so a
stored PDF carries neither a download filename nor a Cache-Control of its own;
caching is the pull zone's configuration.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

import httpx

_TIMEOUT = httpx.Timeout(60.0, connect=10.0)


def new_client(access_key: str, transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    """One client per process, so connections to the storage API are pooled."""
    return httpx.AsyncClient(
        headers={"AccessKey": access_key}, timeout=_TIMEOUT, transport=transport
    )


class BunnyStorage:
    def __init__(self, *, zone: str, endpoint: str, client: httpx.AsyncClient) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._zone_path = "/" + quote(zone, safe="") + "/"
        self._client = client

    def _url(self, key: str) -> str:
        # Every segment is encoded on its own, so `#`, `?` and `%` stay inside
        # the key; `.`, `..` and empty segments are refused outright, and the
        # parsed path is checked to still start with the zone.
        segments = key.split("/")
        if any(s in ("", ".", "..") for s in segments):
            raise ValueError(f"storage key {key!r} has an empty or relative segment")
        url = self._endpoint + self._zone_path + "/".join(quote(s, safe="") for s in segments)
        parsed = httpx.URL(url)
        if not parsed.raw_path.startswith(self._zone_path.encode()) or parsed.query:
            raise ValueError(f"storage key {key!r} leaves the zone")
        return url

    async def exists(self, key: str) -> bool:
        # A one-byte range read, so a present object is not fetched whole.
        resp = await self._client.get(self._url(key), headers={"Range": "bytes=0-0"})
        if resp.status_code == 404:
            return False
        resp.raise_for_status()
        return True

    async def get_text(self, key: str) -> str | None:
        resp = await self._client.get(self._url(key))
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.text

    async def get_json(self, key: str) -> dict[str, Any]:
        resp = await self._client.get(self._url(key))
        resp.raise_for_status()
        return json.loads(resp.content)

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        resp = await self._client.put(
            self._url(key), content=data, headers={"Content-Type": content_type}
        )
        resp.raise_for_status()
