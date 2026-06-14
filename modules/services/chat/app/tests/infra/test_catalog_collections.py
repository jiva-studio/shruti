"""SqliteCatalogRepository collection reads — search + get over a real DB.

Covers the per-locale name search (case-insensitive incl. Cyrillic, where SQL
LIKE COLLATE NOCASE would fail), the featured fallback when no query is given,
ordered track membership, and graceful degradation on an older catalog that
predates the collection tables.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from shruti_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
)


def _make_catalog(path: Path) -> None:
    with sqlite3.connect(path) as c:
        c.executescript(
            """
            CREATE TABLE collections (
                id TEXT, language TEXT, name TEXT, cover TEXT, description TEXT,
                meta TEXT, sort_order INTEGER, PRIMARY KEY (id, language));
            CREATE TABLE collection_tracks (
                collection_id TEXT, collection_language TEXT, track_id TEXT,
                position INTEGER, PRIMARY KEY (collection_id, collection_language, track_id));
            CREATE TABLE collection_tags (
                collection_id TEXT, collection_language TEXT, tag_id TEXT,
                PRIMARY KEY (collection_id, collection_language, tag_id));

            INSERT INTO collections VALUES
                ('pack_iso', 'ru', 'Семинар по Ишопанишад', 'k.jpg', 'Разбор', NULL, 10),
                ('pack_iso', 'en', 'Iso seminar', '', '', NULL, 10),
                ('pack_nod', 'ru', 'Нектар преданности', '', '', NULL, 20);
            INSERT INTO collection_tracks VALUES
                ('pack_iso', 'ru', 'track_b', 1),
                ('pack_iso', 'ru', 'track_a', 0);
            INSERT INTO collection_tags VALUES ('pack_iso', 'ru', 'tag_featured');
            """
        )


@pytest.fixture()
def repo(tmp_path: Path) -> SqliteCatalogRepository:
    cat = tmp_path / "catalog.db"
    _make_catalog(cat)
    return SqliteCatalogRepository(catalog_db_path=cat)


@pytest.mark.asyncio
async def test_search_matches_cyrillic_case_insensitive(repo: SqliteCatalogRepository) -> None:
    # Lowercase query against a Capitalised Cyrillic title — the case SQL
    # LIKE COLLATE NOCASE cannot handle.
    res = await repo.search_collections("ишоп", lang="ru", limit=10)
    assert [c.id for c in res] == ["pack_iso"]
    assert res[0].name == "Семинар по Ишопанишад"
    assert res[0].cover == "k.jpg"
    assert res[0].track_ids == ("track_a", "track_b")  # ordered by position


@pytest.mark.asyncio
async def test_search_no_query_returns_featured(repo: SqliteCatalogRepository) -> None:
    res = await repo.search_collections(None, lang="ru", limit=10)
    assert [c.id for c in res] == ["pack_iso"]  # only the tag_featured one


@pytest.mark.asyncio
async def test_search_is_per_locale(repo: SqliteCatalogRepository) -> None:
    res = await repo.search_collections("seminar", lang="en", limit=10)
    assert [c.id for c in res] == ["pack_iso"]
    assert res[0].name == "Iso seminar"
    # ru-only collection isn't surfaced in en.
    assert await repo.search_collections("Нектар", lang="en", limit=10) == []


@pytest.mark.asyncio
async def test_get_collection(repo: SqliteCatalogRepository) -> None:
    c = await repo.get_collection("pack_iso", lang="ru")
    assert c is not None
    assert c.name == "Семинар по Ишопанишад"
    assert c.track_ids == ("track_a", "track_b")
    assert await repo.get_collection("pack_missing", lang="ru") is None


@pytest.mark.asyncio
async def test_absent_tables_degrade_gracefully(tmp_path: Path) -> None:
    empty = tmp_path / "old_catalog.db"
    sqlite3.connect(empty).close()  # no collection tables (older catalog)
    repo = SqliteCatalogRepository(catalog_db_path=empty)
    assert await repo.search_collections("ишоп", lang="ru", limit=10) == []
    assert await repo.get_collection("pack_iso", lang="ru") is None
