"""S3-backed `TranscriptStorage`.

Pulls transcript JSON from the public CDN bucket via the existing
`indexer.s3.fetch_transcript` helper. The path comes from the catalog
(`track_variants.transcript_path`) — we just open it and parse.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.indexer.s3 import fetch_transcript


class S3TranscriptStorage:
    async def fetch(self, path: str) -> dict[str, Any]:
        return await fetch_transcript(path)
