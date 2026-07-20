"""YouTube Data API v3 adapter — the PRIMARY provider (REAL).

Free tier (10k units/day), returns thumbnails inline, no scraping. Two
calls per search: `search.list` (ids + snippet) then `videos.list`
(contentDetails for the ISO-8601 duration). A 403 with a quota reason maps
to `QuotaExceeded` so the resolver de-prioritises us; other HTTP errors
bubble as generic failures.
"""

from __future__ import annotations

import httpx

from lectorium_chat.lecture_search.models import Candidate
from lectorium_chat.lecture_search.port import QuotaExceeded
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"
_WATCH = "https://www.youtube.com/watch?v="


class YouTubeApiProvider:
    name = "youtube_api"

    def __init__(
        self,
        api_key: str | None,
        *,
        region_code: str = "",
        timeout_s: float = 4.0,
    ) -> None:
        self._api_key = (api_key or "").strip()
        self._region = (region_code or "").strip()
        self._timeout_s = timeout_s

    def available(self) -> bool:
        return bool(self._api_key)

    async def search(self, query: str, *, limit: int) -> list[Candidate]:
        params = {
            "key": self._api_key,
            "part": "snippet",
            "q": query,
            "type": "video",
            "maxResults": str(max(1, min(limit, 25))),
            "safeSearch": "none",
        }
        if self._region:
            params["regionCode"] = self._region
        async with httpx.AsyncClient(timeout=self._timeout_s) as client:
            resp = await client.get(_SEARCH_URL, params=params)
            self._raise_for_quota(resp)
            resp.raise_for_status()
            data = resp.json()
            items = data.get("items") or []
            ids = [
                it["id"]["videoId"]
                for it in items
                if isinstance(it.get("id"), dict) and it["id"].get("videoId")
            ]
            durations = await self._fetch_durations(client, ids)

        out: list[Candidate] = []
        for it in items:
            vid = (it.get("id") or {}).get("videoId")
            if not vid:
                continue
            sn = it.get("snippet") or {}
            out.append(
                Candidate(
                    url=f"{_WATCH}{vid}",
                    title=sn.get("title") or "",
                    author=sn.get("channelTitle") or "",
                    duration=durations.get(vid, ""),
                    thumbnail=_best_thumb(sn.get("thumbnails") or {}),
                    lang_hint=sn.get("defaultAudioLanguage") or "",
                    provider=self.name,
                )
            )
        return out

    async def _fetch_durations(
        self, client: httpx.AsyncClient, ids: list[str]
    ) -> dict[str, str]:
        """Best-effort ISO-8601 durations; a failure just leaves them blank."""
        if not ids:
            return {}
        try:
            resp = await client.get(
                _VIDEOS_URL,
                params={
                    "key": self._api_key,
                    "part": "contentDetails",
                    "id": ",".join(ids),
                },
            )
            self._raise_for_quota(resp)
            resp.raise_for_status()
            return {
                it["id"]: (it.get("contentDetails") or {}).get("duration", "")
                for it in (resp.json().get("items") or [])
                if it.get("id")
            }
        except QuotaExceeded:
            raise
        except Exception as exc:  # noqa: BLE001 — durations are optional
            log.info("youtube_durations_failed", error=type(exc).__name__)
            return {}

    @staticmethod
    def _raise_for_quota(resp: httpx.Response) -> None:
        if resp.status_code != 403:
            return
        try:
            reason = (
                resp.json().get("error", {}).get("errors", [{}])[0].get("reason", "")
            )
        except Exception:  # noqa: BLE001
            reason = ""
        if reason in ("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"):
            raise QuotaExceeded(f"youtube: {reason}")


def _best_thumb(thumbs: dict) -> str:
    for key in ("high", "medium", "default"):
        t = thumbs.get(key)
        if isinstance(t, dict) and t.get("url"):
            return t["url"]
    return ""
