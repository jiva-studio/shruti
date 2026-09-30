"""The YouTube video id in a watch, shorts, live or youtu.be link."""

from __future__ import annotations

import re

_YOUTUBE_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?[^\s<>\]\)]*\bv=|shorts/|live/)|youtu\.be/)"
    r"([\w-]{11})",
    re.IGNORECASE,
)


def find_youtube_id(url: str) -> str | None:
    """The 11-character video id in `url`, or None when it is not a YouTube link."""
    m = _YOUTUBE_ID_RE.search(url or "")
    return m.group(1) if m else None
