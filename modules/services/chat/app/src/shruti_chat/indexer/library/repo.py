"""Runtime SQLite reads of `library.db` for the chat-turn path.

The indexer keeps `library.db` mirrored under `settings.library_db_path`.
At chat-turn time we sometimes need a single-verse body lookup (sanskrit
+ transliteration + translations per language) to ship to the mobile via
the `verse_payload` SSE event — see chat_turn.

This is a SYNC SQLite read wrapped in `asyncio.to_thread`. Holding a
pool/connection across requests would not buy much (SQLite read-only
opens are cheap on a hot-page-cached file) and would complicate restart
behaviour when `library_db_path` is swapped.
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from pathlib import Path
from typing import Any, TypedDict

from shruti_chat.sanskrit import iast_to_cyrillic


# Imported titles carry stray `\r\n` inside the heading text (gitabase
# source). Collapse any run of whitespace to a single space so the chapter
# widget / addr labels render on one clean line.
_WS = re.compile(r"\s+")


def _clean_title(s: str | None) -> str:
    return _WS.sub(" ", (s or "")).strip()


class VerseBody(TypedDict):
    sanskrit: str
    # lang → transliteration. `en` is the clean Latin IAST stored in
    # library.db (the source of truth); `ru` is DERIVED from it on read
    # via `iast_to_cyrillic` (Russian Vaiṣṇava Cyrillic). The SSE layer
    # picks one string by the turn's locale — see `_worker_common`.
    transliteration: dict[str, str]
    translation: dict[str, str]  # lang → translation text
    # Relative S3 key of the Sanskrit recitation, or "" when absent. The
    # SSE layer expands it into a full public URL. Empty for verses with
    # no audio (and for any DB published before the column existed — see
    # the defensive read below).
    audio_path: str


def _fetch_verse_body_sync(library_db: Path, source_id: str, tokens: str) -> VerseBody | None:
    with sqlite3.connect(f"file:{library_db}?mode=ro", uri=True) as conn:
        # `audio_path` was added after the first library.db releases. A DB
        # published before the column exists would make a hard-coded SELECT
        # raise OperationalError, silently dropping EVERY verse payload to
        # the chip fallback. Probe the schema so the chat-service works
        # against both old and new published artifacts.
        has_audio = any(
            r[1] == "audio_path"
            for r in conn.execute("PRAGMA table_info(library_verses)")
        )
        cols = "id, text, transliteration" + (", audio_path" if has_audio else "")
        row = conn.execute(
            f"SELECT {cols} FROM library_verses WHERE source_id = ? AND tokens = ?",
            (source_id, tokens),
        ).fetchone()
        if row is None:
            return None
        if has_audio:
            verse_id, sanskrit, transliteration, audio_path = row
        else:
            verse_id, sanskrit, transliteration = row
            audio_path = None
        translations_rows = conn.execute(
            "SELECT language, translation FROM library_verse_variants "
            "WHERE verse_id = ?",
            (verse_id,),
        ).fetchall()
    iast = transliteration or ""
    return VerseBody(
        sanskrit=sanskrit or "",
        # `en` = the as-is IAST; `ru` = derived Cyrillic. Empty IAST
        # yields empty strings for both (no spurious card content).
        transliteration={"en": iast, "ru": iast_to_cyrillic(iast)} if iast else {},
        translation={lang: text or "" for lang, text in translations_rows},
        audio_path=audio_path or "",
    )


async def fetch_verse_body(
    library_db: Path, source_id: str, tokens: str,
) -> VerseBody | None:
    """Async wrapper. Returns None if the (source_id, tokens) pair is
    missing — the caller can degrade gracefully to the chip-only
    fallback rather than failing the whole SSE stream."""
    if not library_db.exists():
        return None
    return await asyncio.to_thread(_fetch_verse_body_sync, library_db, source_id, tokens)


def _fetch_titles_sync(
    library_db: Path, source_id: str, token_prefix: str, lang: str,
) -> dict[str, str]:
    """{tokens: title} for one book, optionally limited to a token prefix.

    Per-(source_id, tokens) the title is picked with a lang fallback chain
    (requested lang → en → any), so a missing localization still yields a
    heading instead of a blank. Whitespace in titles is normalized.
    """
    out: dict[str, str] = {}
    by_lang: dict[str, dict[str, str]] = {}  # tokens → {lang: title}
    sql = "SELECT tokens, language, title FROM library_titles WHERE source_id = ?"
    args: list[str] = [source_id]
    if token_prefix:
        sql += " AND tokens LIKE ?"
        args.append(token_prefix + "%")
    with sqlite3.connect(f"file:{library_db}?mode=ro", uri=True) as conn:
        for tokens, language, title in conn.execute(sql, args):
            by_lang.setdefault(tokens, {})[language or ""] = _clean_title(title)
    for tokens, variants in by_lang.items():
        title = variants.get(lang) or variants.get("en") or next(iter(variants.values()), "")
        if title:
            out[tokens] = title
    return out


async def fetch_titles(
    library_db: Path, source_id: str, token_prefix: str = "", lang: str = "ru",
) -> dict[str, str]:
    """Async wrapper around the section-title (canto/chapter heading) read.

    Returns `{tokens: title}` for the book — e.g. {"7": "Песнь 7 …",
    "7.5": "Махараджа Прахлада …"}. Empty dict if the DB is absent or the
    book has no titles, so locate degrades to bare addresses."""
    if not library_db.exists():
        return {}
    return await asyncio.to_thread(
        _fetch_titles_sync, library_db, source_id, token_prefix, lang,
    )


def _fetch_document_body_sync(
    library_db: Path, item_id: str, lang: str,
) -> str | None:
    """The full body of one library document, lang-fallback
    (requested → en → any). None if the document/variant is absent."""
    with sqlite3.connect(f"file:{library_db}?mode=ro", uri=True) as conn:
        rows = conn.execute(
            "SELECT language, body FROM library_document_variants "
            "WHERE document_id = ?",
            (item_id,),
        ).fetchall()
    if not rows:
        return None
    by_lang = {language or "": (body or "") for language, body in rows}
    body = by_lang.get(lang) or by_lang.get("en") or next(iter(by_lang.values()), "")
    if not body.strip():
        return None
    return body.strip()


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


def _fetch_media_sync(library_db: Path, media_id: str) -> MediaRow | None:
    """One `library_media` row by id, with `meta` parsed to a dict.

    None when the table doesn't exist (older library.db) or the id is
    absent — callers degrade gracefully rather than failing the turn.
    """
    with sqlite3.connect(f"file:{library_db}?mode=ro", uri=True) as conn:
        has_table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_media'"
        ).fetchone()
        if not has_table:
            return None
        row = conn.execute(
            "SELECT id, lang, title, text, context, embed_text, url, type, meta "
            "FROM library_media WHERE id = ?",
            (media_id,),
        ).fetchone()
    if row is None:
        return None
    mid, lang, title, text, context, embed_text, url, mtype, meta = row
    try:
        meta_obj = json.loads(meta) if meta else {}
    except (TypeError, ValueError):
        meta_obj = {}
    return MediaRow(
        id=mid,
        lang=lang or "",
        title=title or "",
        text=text or "",
        context=context or "",
        embed_text=embed_text or "",
        url=url or "",
        type=mtype or "",
        meta=meta_obj,
    )


async def fetch_media(library_db: Path, media_id: str) -> MediaRow | None:
    """Async wrapper around the single-`library_media`-row read. Returns
    None if the DB / table / id is absent."""
    if not library_db.exists():
        return None
    return await asyncio.to_thread(_fetch_media_sync, library_db, media_id)


async def fetch_document_body(
    library_db: Path, item_id: str, lang: str = "ru",
) -> str | None:
    """Async wrapper. Returns the canonical full body of a library document
    (commentary / prose_chapter / letter) straight from library.db, NOT
    reassembled from the overlapping Postgres search chunks — so a pinned
    document cites cleanly, with no chunk-overlap repeats. None if absent,
    so the caller degrades to the chunk path."""
    if not library_db.exists():
        return None
    return await asyncio.to_thread(_fetch_document_body_sync, library_db, item_id, lang)
