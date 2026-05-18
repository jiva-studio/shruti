"""PdfStorage — port for caching transcript PDFs on the public CDN.

The chat agent's `generate_track_pdf` tool renders a track's transcript
into a printable PDF and uploads it under a deterministic public key.
The mobile client and any out-of-app reader can read the artifact
directly over HTTPS — no signing required.

Cache key is the domain-level `(track_id, lang)` pair, mirroring
`OutlineCache`. Unlike outlines (internal artifact under `artifacts/`),
PDFs live under `public/` so the URL returned by `public_url` is
anonymously readable.
"""

from __future__ import annotations

from typing import Protocol


class PdfStorage(Protocol):
    async def head(self, track_id: str, lang: str) -> bool:
        """Whether a cached PDF exists for `(track_id, lang)`."""
        ...

    def public_url(self, track_id: str, lang: str) -> str:
        """Deterministic public HTTPS URL for the artifact.

        Sync — the URL is derived from the key, no network call. Use
        `head` to check existence before treating the URL as resolvable.
        """
        ...

    async def put(
        self,
        track_id: str,
        lang: str,
        pdf_bytes: bytes,
        *,
        download_filename: str | None = None,
    ) -> str:
        """Upload `pdf_bytes` to the canonical key. Return the public URL.

        Always overwrites — the artifact is content-addressed only by
        `(track_id, lang)`, not by transcript revision; regenerating
        replaces the previous PDF in place.

        `download_filename`, when provided, is set as the human-
        readable filename in the artifact's `Content-Disposition`
        header so a direct browser download lands with that name.
        Mobile clients that pre-cache the file under a local name pass
        whatever they want regardless — this only governs the CDN
        response.
        """
        ...
