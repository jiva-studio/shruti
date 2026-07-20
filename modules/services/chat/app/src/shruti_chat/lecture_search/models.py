"""`Candidate` — the normalized external-lecture search result.

Every provider (YouTube API, yt-dlp, SerpApi, DataForSEO) returns rows in
its own shape; each adapter maps them into this one so the resolver and
the worker never branch on the source. `url` is the only required field —
it's what gets published to `ingest.request` for the ingest worker (#1224)
to fetch. Everything else is best-effort display metadata.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Candidate(BaseModel):
    """One external lecture the user might add to their library.

    Immutable-ish value object (pydantic model): built by an adapter,
    ranked/deduped by the resolver, rendered as a card by the worker.
    `provider` records which adapter produced it — surfaced for
    observability and so the worker can label the card source.
    """

    model_config = ConfigDict(frozen=True)

    url: str
    title: str = ""
    author: str = ""
    duration: str = ""        # human/ISO8601 duration string, provider-dependent
    thumbnail: str = ""       # absolute image URL, "" when the source has none
    lang_hint: str = ""       # BCP-47-ish hint ("en", "ru"), "" when unknown
    provider: str = ""        # adapter name that produced this candidate
