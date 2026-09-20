"""SQLite adapter for `LibraryRepository` — runtime reads of `library.db`.

The indexer keeps `library.db` mirrored under `settings.library_db_path`.
At chat-turn time we sometimes need a single-verse body lookup (sanskrit
+ transliteration + translations per language) to ship to the mobile via
the `verse_payload` SSE event — see chat_turn.

These are SYNC SQLite reads wrapped in `asyncio.to_thread`. The adapter
holds the PATH, not a connection: a pool/connection across requests would
not buy much (SQLite read-only opens are cheap on a hot-page-cached file)
and would complicate restart behaviour when the file is swapped under it
by the indexer.
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from pathlib import Path

from lectorium_chat.domain.ports.library_repository import MediaRow, VerseBody
from lectorium_chat.sanskrit import iast_to_ru, iast_to_sr, iast_to_uk


# Imported titles carry stray `\r\n` inside the heading text (gitabase
# source). Collapse any run of whitespace to a single space so the chapter
# widget / addr labels render on one clean line.
_WS = re.compile(r"\s+")


def _clean_title(s: str | None) -> str:
    return _WS.sub(" ", (s or "")).strip()


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
        # Per-language transliteration is materialised in the DB (computed once at
        # import). Prefer it — it's the single source of truth. Guard the table's
        # existence so an older published artifact that predates it doesn't raise
        # and drop the whole payload.
        has_translit = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' "
            "AND name='library_verse_transliterations'"
        ).fetchone() is not None
        stored_translit = {}
        if has_translit:
            stored_translit = {
                lang: text or ""
                for lang, text in conn.execute(
                    "SELECT language, text FROM library_verse_transliterations "
                    "WHERE verse_id = ?",
                    (verse_id,),
                ).fetchall()
            }
    iast = transliteration or ""
    # Fallback derivation only when the DB has no stored transliteration (old
    # artifact / missing row); `en`/`sr-Latn` = raw IAST, `ru`/`uk`/`sr-Cyrl` derived.
    translit_map = stored_translit or (
        {
            "en": iast,
            "ru": iast_to_ru(iast),
            "uk": iast_to_uk(iast),
            "sr-Latn": iast,
            "sr-Cyrl": iast_to_sr(iast),
        }
        if iast
        else {}
    )
    return VerseBody(
        sanskrit=sanskrit or "",
        transliteration=translit_map,
        translation={lang: text or "" for lang, text in translations_rows},
        audio_path=audio_path or "",
    )


def _fetch_verse_commentary_sync(
    library_db: Path, source_id: str, tokens: str, lang: str,
) -> str | None:
    with sqlite3.connect(f"file:{library_db}?mode=ro", uri=True) as conn:
        row = conn.execute(
            "SELECT id FROM library_documents "
            "WHERE source_id = ? AND tokens = ? AND kind = 'commentary' LIMIT 1",
            (source_id, tokens),
        ).fetchone()
        if row is None:
            return None
        variants = dict(
            conn.execute(
                "SELECT language, body FROM library_document_variants WHERE document_id = ?",
                (row[0],),
            ).fetchall()
        )
    return variants.get(lang) or variants.get("en") or next(iter(variants.values()), None)


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


class SqliteLibraryRepository:
    """`LibraryRepository` over the published `library.db` snapshot.

    Every read re-checks that the file exists and returns the empty answer
    when it doesn't — the snapshot is absent until the first indexer run,
    and a turn must degrade instead of failing.
    """

    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path)

    async def fetch_verse_body(
        self, source_id: str, tokens: str,
    ) -> VerseBody | None:
        if not self._db_path.exists():
            return None
        return await asyncio.to_thread(
            _fetch_verse_body_sync, self._db_path, source_id, tokens,
        )

    async def fetch_verse_commentary(
        self, source_id: str, tokens: str, *, lang: str,
    ) -> str | None:
        if not self._db_path.exists():
            return None
        return await asyncio.to_thread(
            _fetch_verse_commentary_sync, self._db_path, source_id, tokens, lang,
        )

    async def fetch_titles(
        self, source_id: str, token_prefix: str = "", lang: str = "ru",
    ) -> dict[str, str]:
        if not self._db_path.exists():
            return {}
        return await asyncio.to_thread(
            _fetch_titles_sync, self._db_path, source_id, token_prefix, lang,
        )

    async def fetch_document_body(
        self, item_id: str, lang: str = "ru",
    ) -> str | None:
        if not self._db_path.exists():
            return None
        return await asyncio.to_thread(
            _fetch_document_body_sync, self._db_path, item_id, lang,
        )

    async def fetch_media(self, media_id: str) -> MediaRow | None:
        if not self._db_path.exists():
            return None
        return await asyncio.to_thread(
            _fetch_media_sync, self._db_path, media_id,
        )
