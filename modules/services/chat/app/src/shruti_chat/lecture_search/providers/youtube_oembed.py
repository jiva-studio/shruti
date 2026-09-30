"""YouTube oEmbed adapter: title, author and cover of one YouTube link.

Keyless and best-effort. It describes a URL the user already chose; it does
not search.
"""

from __future__ import annotations

import httpx

from shruti_chat.lecture_search.models import Candidate
from shruti_chat.lecture_search.youtube import find_youtube_id

_OEMBED_URL = "https://www.youtube.com/oembed"


class YouTubeOEmbed:
    def __init__(self, *, timeout_s: float = 2.0) -> None:
        self._timeout_s = timeout_s

    async def describe(self, url: str) -> Candidate | None:
        """The link's card metadata, or None for a non-YouTube URL, a non-200
        answer, a body that is not a JSON object or any failure."""
        if find_youtube_id(url) is None:
            return None
        try:
            async with httpx.AsyncClient(timeout=self._timeout_s) as client:
                resp = await client.get(_OEMBED_URL, params={"url": url, "format": "json"})
            if resp.status_code != 200:
                return None
            data = resp.json()
            if not isinstance(data, dict):
                return None
        except Exception:  # noqa: BLE001 — metadata is best-effort, never fail the add
            return None
        return Candidate(
            url=url,
            title=str(data.get("title") or ""),
            author=str(data.get("author_name") or ""),
            thumbnail=str(data.get("thumbnail_url") or ""),
            provider="user_link",
        )
