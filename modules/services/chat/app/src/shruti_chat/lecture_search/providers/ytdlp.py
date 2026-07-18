"""yt-dlp `ytsearch` adapter — SECONDARY provider (STUBBED-but-structured).

yt-dlp needs the `yt_dlp` package (and network egress to YouTube) which the
chat container doesn't ship today, so this adapter is inert by default:
`available()` is False unless explicitly enabled AND the import succeeds.
The extraction shape is written out so wiring it later is a config flip +
adding the dep, not new code.
"""

from __future__ import annotations

import asyncio

from shruti_chat.lecture_search.models import Candidate
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


class YtDlpProvider:
    name = "ytdlp"

    def __init__(self, *, enabled: bool = False) -> None:
        self._enabled = enabled

    def available(self) -> bool:
        if not self._enabled:
            return False
        try:
            import yt_dlp  # noqa: F401
        except Exception:  # noqa: BLE001 — package not installed → inert
            return False
        return True

    async def search(self, query: str, *, limit: int) -> list[Candidate]:
        # Run the blocking extractor off the event loop. Reached only when
        # `available()` returned True, i.e. yt_dlp imports.
        return await asyncio.to_thread(self._search_sync, query, limit)

    def _search_sync(self, query: str, limit: int) -> list[Candidate]:
        import yt_dlp  # type: ignore

        opts = {"quiet": True, "skip_download": True, "extract_flat": "in_playlist"}
        out: list[Candidate] = []
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{max(1, limit)}:{query}", download=False)
        for entry in (info or {}).get("entries") or []:
            url = entry.get("url") or entry.get("webpage_url") or ""
            if url and not url.startswith("http"):
                url = f"https://www.youtube.com/watch?v={url}"
            if not url:
                continue
            dur = entry.get("duration")
            out.append(
                Candidate(
                    url=url,
                    title=entry.get("title") or "",
                    author=entry.get("uploader") or entry.get("channel") or "",
                    duration=str(dur) if dur is not None else "",
                    thumbnail=entry.get("thumbnail") or "",
                    provider=self.name,
                )
            )
        return out
