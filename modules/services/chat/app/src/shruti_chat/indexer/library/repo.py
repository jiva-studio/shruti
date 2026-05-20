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
import sqlite3
from pathlib import Path
from typing import TypedDict


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
