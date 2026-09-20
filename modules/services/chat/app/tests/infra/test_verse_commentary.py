"""fetch_verse_commentary — deterministic full-purport read used by show_verse
to summarize the purport in the same LLM turn (no embeddings, no fanout)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from lectorium_chat.infra.repositories.sqlite_library_repository import (
    SqliteLibraryRepository,
)


@pytest.fixture()
def repo(tmp_path: Path) -> SqliteLibraryRepository:
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
    return SqliteLibraryRepository(db)


@pytest.mark.asyncio
async def test_returns_purport_in_lang(repo: SqliteLibraryRepository) -> None:
    body = await repo.fetch_verse_commentary("src_bg", "2.13", lang="ru")
    assert body == "Душа неизменна."


@pytest.mark.asyncio
async def test_lang_fallback_to_en(repo: SqliteLibraryRepository) -> None:
    body = await repo.fetch_verse_commentary("src_bg", "2.13", lang="es")
    assert body == "The soul is unchanging."


@pytest.mark.asyncio
async def test_none_when_no_commentary(repo: SqliteLibraryRepository) -> None:
    # 9.9 has only a 'translation' doc, not a 'commentary' one.
    assert await repo.fetch_verse_commentary("src_bg", "9.9", lang="ru") is None
    assert await repo.fetch_verse_commentary("src_bg", "1.1", lang="ru") is None


@pytest.mark.asyncio
async def test_none_when_db_missing(tmp_path: Path) -> None:
    missing = SqliteLibraryRepository(tmp_path / "nope.db")
    assert await missing.fetch_verse_commentary("src_bg", "2.13", lang="ru") is None
