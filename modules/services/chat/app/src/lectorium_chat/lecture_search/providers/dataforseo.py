"""DataForSEO adapter — LAST-RESORT provider (STUBBED-but-structured).

DataForSEO's YouTube Organic (live/advanced) endpoint returns SERP items
behind HTTP Basic auth (login/password). Real request shape is written out;
the adapter is inert (`available() == False`) until both credentials are
set. A 402/429 maps to `QuotaExceeded`.
"""

from __future__ import annotations

import httpx

from lectorium_chat.lecture_search.models import Candidate
from lectorium_chat.lecture_search.port import QuotaExceeded

_URL = "https://api.dataforseo.com/v3/serp/youtube/organic/live/advanced"


class DataForSeoProvider:
    name = "dataforseo"

    def __init__(
        self,
        login: str | None,
        password: str | None,
        *,
        timeout_s: float = 5.0,
    ) -> None:
        self._login = (login or "").strip()
        self._password = (password or "").strip()
        self._timeout_s = timeout_s

    def available(self) -> bool:
        return bool(self._login and self._password)

    async def search(self, query: str, *, limit: int) -> list[Candidate]:
        payload = [{"keyword": query, "depth": max(1, limit)}]
        async with httpx.AsyncClient(timeout=self._timeout_s) as client:
            resp = await client.post(
                _URL, json=payload, auth=(self._login, self._password)
            )
            if resp.status_code in (402, 429):
                raise QuotaExceeded("dataforseo: quota/payment")
            resp.raise_for_status()
            data = resp.json()
        out: list[Candidate] = []
        for task in data.get("tasks") or []:
            for result in task.get("result") or []:
                for item in (result.get("items") or [])[:limit]:
                    url = item.get("url") or ""
                    if not url:
                        continue
                    out.append(
                        Candidate(
                            url=url,
                            title=item.get("title") or "",
                            author=item.get("channel_name") or "",
                            duration=item.get("timestamp") or "",
                            thumbnail=item.get("thumbnail_url") or "",
                            provider=self.name,
                        )
                    )
        return out[:limit]
