"""Deterministic rule: a pasted external lecture URL → add-to-library.

The LLM router classifies a message that is *just* a pasted YouTube / audio link
unreliably — it tends to fall back to `unknown` → research and answer about
something unrelated. Pasting a lecture link IS the request to add it to the
personal library, so claim it here with an exact, cheap rule: no LLM call, no
dependency on a Langfuse prompt deploy. A link embedded in a longer question
(a real query that merely contains a URL) falls through to the LLM router.

Mirrors the concrete-URL detection in `add_to_library_worker` so the two agree
on what "a lecture the user points AT" means.
"""

from __future__ import annotations

import re

from lectorium_chat.agent.classify.base import ClassifierContext
from lectorium_chat.domain.routing import RoutingDecision

# Kept in sync with add_to_library_worker._YOUTUBE_URL_RE / _AUDIO_URL_RE.
_YOUTUBE_URL_RE = re.compile(
    r"https?://(?:www\.|m\.|music\.)?"
    r"(?:youtube\.com/(?:watch\?[^\s<>\]\)]*\bv=[\w-]+|shorts/[\w-]+|live/[\w-]+)"
    r"|youtu\.be/[\w-]+)"
    r"[^\s<>\]\)]*",
    re.IGNORECASE,
)
_AUDIO_URL_RE = re.compile(
    r"https?://[^\s<>\]\)]+\.(?:mp3|m4a|aac|wav|ogg|oga|opus|flac)"
    r"(?:\?[^\s<>\]\)]*)?",
    re.IGNORECASE,
)
_URL_RE = re.compile(r"https?://[^\s<>\]\)]+", re.IGNORECASE)

# How much non-URL text may surround the link and still count as "the user is
# pointing at this lecture" (covers a bare link, or a short add/save phrase).
# Beyond this it's a real question that happens to include a link → let the LLM
# route it.
_MAX_SURROUNDING_CHARS = 40


def _concrete_lecture_url(text: str) -> str | None:
    for rx in (_YOUTUBE_URL_RE, _AUDIO_URL_RE):
        m = rx.search(text or "")
        if m:
            return m.group(0)
    return None


class LectureUrlClassifier:
    """Chain link: a bare/short-context external lecture URL → `add-to-library`."""

    name = "lecture_url"

    async def classify(
        self, query: str, ctx: ClassifierContext
    ) -> RoutingDecision | None:
        if _concrete_lecture_url(query) is None:
            return None
        remainder = _URL_RE.sub("", query or "").strip()
        if len(remainder) > _MAX_SURROUNDING_CHARS:
            return None
        # The worker still does the PRO gate and the actual publish; we only
        # claim the intent so the LLM can't misroute a pasted link.
        return RoutingDecision(
            intent="add-to-library", confidence=1.0, extracted_args={}
        )
