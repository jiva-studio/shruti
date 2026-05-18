"""S3-backed `PdfStorage`.

Writes the printable PDF under `public/tracks/<id>/exports/<lang>.pdf`
— same prefix family as the catalog DB and transcripts, so the file is
anonymously readable over HTTPS without signing. The public URL is
deterministic from `(track_id, lang)` and computed locally; `head` is
the only roundtrip needed before treating the URL as resolvable.
"""

from __future__ import annotations

import asyncio

from shruti_chat.config import Settings
from shruti_chat.indexer.s3 import (
    put_track_pdf_sync,
    track_pdf_exists_sync,
    track_pdf_public_url,
)


class S3PdfStorage:
    def __init__(self, *, settings: Settings) -> None:
        self._settings = settings

    async def head(self, track_id: str, lang: str) -> bool:
        return await asyncio.to_thread(
            track_pdf_exists_sync, track_id, lang, self._settings,
        )

    def public_url(self, track_id: str, lang: str) -> str:
        return track_pdf_public_url(track_id, lang, self._settings)

    async def put(
        self,
        track_id: str,
        lang: str,
        pdf_bytes: bytes,
        *,
        download_filename: str | None = None,
    ) -> str:
        await asyncio.to_thread(
            put_track_pdf_sync, track_id, lang, pdf_bytes, self._settings,
            download_filename=download_filename,
        )
        return self.public_url(track_id, lang)
