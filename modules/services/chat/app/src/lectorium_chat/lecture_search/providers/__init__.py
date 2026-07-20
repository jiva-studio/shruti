"""Concrete `LectureSearchProvider` adapters.

YouTube Data API v3 is the only REAL adapter (free, thumbnails); the rest
are structured but stubbed where a key/binary is absent — they advertise
`available() == False` and never run until wired. `build_default_providers`
assembles them in the resolver's preference order from `Settings`.
"""

from __future__ import annotations

from lectorium_chat.config import Settings
from lectorium_chat.lecture_search.port import LectureSearchProvider
from lectorium_chat.lecture_search.providers.dataforseo import DataForSeoProvider
from lectorium_chat.lecture_search.providers.serpapi import SerpApiProvider
from lectorium_chat.lecture_search.providers.youtube_api import YouTubeApiProvider
from lectorium_chat.lecture_search.providers.ytdlp import YtDlpProvider

__all__ = [
    "YouTubeApiProvider",
    "YtDlpProvider",
    "SerpApiProvider",
    "DataForSeoProvider",
    "build_default_providers",
]


def build_default_providers(settings: Settings) -> list[LectureSearchProvider]:
    """Preference-ordered provider list: YouTube API → yt-dlp → SerpApi →
    DataForSEO. Adapters whose credentials/binary are missing are still
    included (they self-report `available() == False`), so ordering config
    stays stable regardless of which keys a deployment ships."""
    return [
        YouTubeApiProvider(
            api_key=settings.youtube_api_key,
            region_code=settings.lecture_search_region,
        ),
        YtDlpProvider(enabled=settings.lecture_search_ytdlp_enabled),
        SerpApiProvider(api_key=settings.serpapi_api_key),
        DataForSeoProvider(
            login=settings.dataforseo_login,
            password=settings.dataforseo_password,
        ),
    ]
