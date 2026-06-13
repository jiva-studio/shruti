"""fetch_verse_commentary — deterministic full-purport read used by show_verse
to summarize the purport in the same LLM turn (no embeddings, no fanout)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from shruti_chat.indexer.library.repo import fetch_verse_commentary


@pytest.fixture()
def lib(tmp_path: Path) -> Path:
    db = tmp_path / "library.db"
    with sqlite3.connect(db) as c:
        c.execute(
            "CREATE TABLE library_documents (id TEXT PRIMARY KEY, source_id TEXT, "
            "tokens TEXT, author_id TEXT, kind TEXT, date TEXT)"
        )
        c.execute(
            "CREATE TABLE library_document_variants (document_id TEXT, language TEXT, "
            "title TEXT, body TEXT, PRIMARY KEY (document_id, language))"
        )
        c.executemany(
            "INSERT INTO library_documents (id, source_id, tokens, author_id, kind) VALUES (?,?,?,?,?)",
            [("doc_bg213", "src_bg", "2.13", "a", "commentary"),
             ("doc_x", "src_bg", "9.9", "a", "translation")],  # non-commentary
        )
        c.executemany(
            "INSERT INTO library_document_variants (document_id, language, body) VALUES (?,?,?)",
            [("doc_bg213", "ru", "Душа неизменна."), ("doc_bg213", "en", "The soul is unchanging.")],
        )
    return db


@pytest.mark.asyncio
async def test_returns_purport_in_lang(lib: Path) -> None:
    assert await fetch_verse_commentary(lib, "src_bg", "2.13", lang="ru") == "Душа неизменна."


@pytest.mark.asyncio
async def test_lang_fallback_to_en(lib: Path) -> None:
    assert await fetch_verse_commentary(lib, "src_bg", "2.13", lang="es") == "The soul is unchanging."


@pytest.mark.asyncio
async def test_none_when_no_commentary(lib: Path) -> None:
    # 9.9 has only a 'translation' doc, not a 'commentary' one.
    assert await fetch_verse_commentary(lib, "src_bg", "9.9", lang="ru") is None
    assert await fetch_verse_commentary(lib, "src_bg", "1.1", lang="ru") is None


@pytest.mark.asyncio
async def test_none_when_db_missing(tmp_path: Path) -> None:
    assert await fetch_verse_commentary(tmp_path / "nope.db", "src_bg", "2.13", lang="ru") is None
