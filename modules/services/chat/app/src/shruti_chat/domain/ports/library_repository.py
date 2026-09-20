"""LibraryRepository — port for `library.db` reads on the chat-turn path.

The indexer publishes a SQLite snapshot of the scripture library; a turn
reads single rows out of it (a verse body for the `verse_payload` SSE
event, a purport, chapter headings, a document body, a media clip).

Five reads, no generic query escape hatch — new use-cases extend the
port explicitly. The adapter lives in
`infra/repositories/sqlite_library_repository.py`.
"""

from __future__ import annotations

from typing import Any, Protocol, TypedDict


class VerseBody(TypedDict):
    sanskrit: str
    # lang → transliteration. `en`/`sr-Latn` are the clean Latin IAST stored
    # in library.db (the source of truth); `ru`/`uk`/`sr-Cyrl` are DERIVED
    # from it on read via the per-language transliterators. The SSE layer
    # picks one string by the turn's locale — see `_worker_common`.
    transliteration: dict[str, str]
    translation: dict[str, str]  # lang → translation text
    # Relative S3 key of the Sanskrit recitation, or "" when absent. The
    # SSE layer expands it into a full public URL. Empty for verses with
    # no audio (and for any DB published before the column existed).
    audio_path: str


class MediaRow(TypedDict):
    id: str
    lang: str
    title: str
    text: str
    context: str
    embed_text: str
    url: str
    type: str
    meta: dict[str, Any]


class LibraryRepository(Protocol):
    async def fetch_verse_body(
        self, source_id: str, tokens: str,
    ) -> VerseBody | None:
        """Sanskrit + per-language transliteration + translations for one
        verse. None when the (source_id, tokens) pair is missing — the
        caller degrades to the chip-only fallback rather than failing the
        whole SSE stream."""
        ...

    async def fetch_verse_commentary(
        self, source_id: str, tokens: str, *, lang: str,
    ) -> str | None:
        """Full purport (commentary body) for a verse, in `lang` with
        en/any fallback. None when the verse has no commentary doc."""
        ...

    async def fetch_titles(
        self, source_id: str, token_prefix: str = "", lang: str = "ru",
    ) -> dict[str, str]:
        """`{tokens: title}` section headings (canto / chapter) for one
        book, optionally limited to a token prefix — e.g. {"7": "Песнь 7 …",
        "7.5": "Махараджа Прахлада …"}. Empty dict when the book has no
        titles, so locate degrades to bare addresses."""
        ...

    async def fetch_document_body(
        self, item_id: str, lang: str = "ru",
    ) -> str | None:
        """The canonical full body of a library document (commentary /
        prose_chapter / letter), NOT reassembled from the overlapping
        Postgres search chunks — so a pinned document cites cleanly. None
        if absent, so the caller degrades to the chunk path."""
        ...

    async def fetch_media(self, media_id: str) -> MediaRow | None:
        """One `library_media` row by id, `meta` parsed to a dict. None
        when the id (or the whole table, on an older snapshot) is absent."""
        ...
