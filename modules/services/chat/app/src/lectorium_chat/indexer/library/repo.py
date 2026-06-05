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
import re
import sqlite3
from pathlib import Path
from typing import TypedDict


# Imported titles carry stray `\r\n` inside the heading text (gitabase
# source). Collapse any run of whitespace to a single space so the chapter
# widget / addr labels render on one clean line.
_WS = re.compile(r"\s+")


def _clean_title(s: str | None) -> str:
    return _WS.sub(" ", (s or "")).strip()


class VerseBody(TypedDict):
    sanskrit: str
    transliteration: str
    translation: dict[str, str]  # lang → translation text


def _fetch_verse_body_sync(library_db: Path, source_id: str, tokens: str) -> VerseBody | None:
    with sqlite3.connect(f"file:{library_db}?mode=ro", uri=True) as conn:
        row = conn.execute(
            "SELECT id, text, transliteration FROM library_verses "
            "WHERE source_id = ? AND tokens = ?",
            (source_id, tokens),
        ).fetchone()
        if row is None:
            return None
        verse_id, sanskrit, transliteration = row
        translations_rows = conn.execute(
            "SELECT language, translation FROM library_verse_variants "
            "WHERE verse_id = ?",
            (verse_id,),
        ).fetchall()
    return VerseBody(
        sanskrit=sanskrit or "",
        transliteration=transliteration or "",
        translation={lang: text or "" for lang, text in translations_rows},
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
