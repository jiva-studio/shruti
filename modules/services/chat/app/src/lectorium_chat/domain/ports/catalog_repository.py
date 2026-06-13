"""CatalogRepository — port for SQLite catalog reads.

Three families of operations the application needs:

- `get_track` — full metadata for one track, denormalised in a given lang
- `list_tracks` — filtered listing with title-FTS, dates, tags, etc
- `filter_track_ids` — narrow projection used to constrain ANN searches
- `resolve` — LLM-fuzzy dictionary lookup against authors / sources /
  locations / tags

`invalidate_cache` is an out-of-band hook the indexer calls after a
catalog swap so any in-memory caching the adapter does gets dropped.
"""

from __future__ import annotations

from typing import Literal, Protocol

from lectorium_chat.domain.entities import ResolvedEntity, Track


ResolveKind = Literal["author", "source", "location", "tag"]


class CatalogRepository(Protocol):
    async def get_track(self, track_id: str, *, lang: str) -> Track | None:
        ...

    async def filter_existing_track_ids(self, track_ids: list[str]) -> list[str]:
        """Return the subset of `track_ids` that exist in the catalog and
        are not hidden. Used by action proposals to validate input."""
        ...

    async def resolve_transcript_path(
        self, track_id: str, *, requested_lang: str,
    ) -> tuple[str | None, str]:
        """Return `(transcript_path, effective_lang)` for a track.

        Prefer the requested language; fall back to ANY available
        transcript variant when the requested lang has none. Returns
        `(None, requested_lang)` if the track has no transcripts at all.
        """
        ...

    async def list_tracks(
        self,
        *,
        author_id: str | None,
        source_id: str | None,
        location_id: str | None,
        tag_ids: list[str] | None,
        title_query: str | None,
        date_from: str | None,
        date_to: str | None,
        lang: str | None,
        limit: int,
        offset: int,
        ref_prefix: str | None = None,
        ref_from: int | None = None,
        ref_to: int | None = None,
    ) -> list[Track]:
        ...

    async def filter_track_ids(
        self,
        *,
        author_id: str | None,
        source_id: str | None,
        location_id: str | None,
        tag_ids: list[str] | None,
        date_from: str | None,
        date_to: str | None,
    ) -> list[str] | None:
        """Return eligible track_ids for the metadata filters, or None
        when no filter is active (caller should skip the constraint)."""
        ...

    async def resolve(
        self,
        kind: ResolveKind,
        text: str,
        *,
        lang: str | None,
        limit: int,
    ) -> list[ResolvedEntity]:
        ...

    async def get_author_names(
        self,
        author_ids: list[str],
        *,
        lang: str,
    ) -> dict[str, str]:
        """Batch-resolve author_id → full_name for the given language.
        Missing rows are simply absent from the returned dict (caller
        falls back to author_id if no name is available)."""
        ...

    async def source_short_label(self, source_id: str, *, lang: str) -> str | None:
        """Short display name for a source ("БГ" / "BG" / "CC Madhya"),
        in `lang` with an en fallback. None when the source is unknown.
        Used to compose a human verse address ("БГ 2.13") for show_verse."""
        ...

    async def language_name(self, code: str) -> str | None:
        """Native language name for a locale code from the `languages` table
        ("ru"→"Русский", "sr-Latn"→"Srpski"). None when unknown. Used so the
        synthesizer's language directive names the language instead of passing
        a bare code the LLM mis-resolves."""
        ...

    def invalidate_cache(self) -> None:
        """Hook for the indexer to call after the catalog DB swaps."""
        ...
