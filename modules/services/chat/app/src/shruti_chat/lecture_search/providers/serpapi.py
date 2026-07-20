"""SerpApi adapter — TERTIARY provider (STUBBED-but-structured).

SerpApi's YouTube engine returns organic video results with thumbnails +
durations. Real HTTP shape is written out; the adapter is inert
(`available() == False`) until `SERPAPI_API_KEY` is set. A 429 maps to
`QuotaExceeded` (free tier is 250 searches/mo — worth de-prioritising, not
failing).
"""

from __future__ import annotations

import httpx

from shruti_chat.lecture_search.models import Candidate
from shruti_chat.lecture_search.port import QuotaExceeded

_URL = "https://serpapi.com/search.json"


class SerpApiProvider:
    name = "serpapi"

    def __init__(self, api_key: str | None, *, timeout_s: float = 4.0) -> None:
        self._api_key = (api_key or "").strip()
        self._timeout_s = timeout_s

    def available(self) -> bool:
        return bool(self._api_key)

    async def search(self, query: str, *, limit: int) -> list[Candidate]:
        params = {
            "engine": "youtube",
            "search_query": query,
            "api_key": self._api_key,
        }
        async with httpx.AsyncClient(timeout=self._timeout_s) as client:
            resp = await client.get(_URL, params=params)
            if resp.status_code == 429:
                raise QuotaExceeded("serpapi: rate/quota")
            resp.raise_for_status()
            data = resp.json()
        out: list[Candidate] = []
        for v in (data.get("video_results") or [])[:limit]:
            url = v.get("link") or ""
            if not url:
                continue
            out.append(
                Candidate(
                    url=url,
                    title=v.get("title") or "",
                    author=(v.get("channel") or {}).get("name") or "",
                    duration=v.get("length") or "",
                    thumbnail=(v.get("thumbnail") or {}).get("static") or "",
                    provider=self.name,
                )
            )
        return out
