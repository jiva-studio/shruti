"""SqliteCatalogRepository topic reads — the signal behind the
deterministic "what to listen next" recommender.

Covers the three methods that mirror the mobile `ITopicRepository`:
weights per track, top tracks per topic (with the language-EXISTS
filter), and per-locale topic names with en fallback.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from lectorium_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
)


def _make_catalog(path: Path) -> None:
    with sqlite3.connect(path) as c:
        c.executescript(
            """
            CREATE TABLE track_topics (
                track_id TEXT, topic_id TEXT, weight REAL,
                PRIMARY KEY (track_id, topic_id));
            CREATE TABLE topics (
                id TEXT, language TEXT, full_name TEXT, short_name TEXT, cover TEXT,
                PRIMARY KEY (id, language));
            CREATE TABLE track_variants (
                track_id TEXT, language TEXT, title TEXT, audio_duration INTEGER,
                PRIMARY KEY (track_id, language));

            INSERT INTO track_topics VALUES
                ('t1', 'bhakti', 0.9),
                ('t1', 'karma',  0.4),
                ('t2', 'bhakti', 0.7),
                ('t3', 'bhakti', 0.5),
                ('t4', 'karma',  0.8);
            INSERT INTO topics VALUES
                ('bhakti', 'ru', 'Бхакти', 'Бхакти', NULL),
                ('bhakti', 'en', 'Bhakti', 'Bhakti', NULL),
                ('karma',  'en', 'Karma',  'Karma',  NULL);
            -- t1 ru+en, t2 en-only, t3 ru-only, t4 en-only.
            INSERT INTO track_variants VALUES
                ('t1', 'ru', 'L1', 0), ('t1', 'en', 'L1e', 0),
                ('t2', 'en', 'L2', 0),
                ('t3', 'ru', 'L3', 0),
                ('t4', 'en', 'L4', 0);
            """
        )


@pytest.fixture()
def repo(tmp_path: Path) -> SqliteCatalogRepository:
    cat = tmp_path / "catalog.db"
    _make_catalog(cat)
    return SqliteCatalogRepository(catalog_db_path=cat)


@pytest.mark.asyncio
async def test_topic_weights_for_tracks(repo: SqliteCatalogRepository) -> None:
    rows = await repo.topic_weights_for_tracks(["t1", "t2"])
    assert set(rows) == {
        ("t1", "bhakti", 0.9),
        ("t1", "karma", 0.4),
        ("t2", "bhakti", 0.7),
    }


@pytest.mark.asyncio
async def test_topic_weights_empty_input(repo: SqliteCatalogRepository) -> None:
    assert await repo.topic_weights_for_tracks([]) == []


@pytest.mark.asyncio
async def test_top_track_ids_orders_by_weight(repo: SqliteCatalogRepository) -> None:
    # No language filter → weight DESC: t1 (0.9), t2 (0.7), t3 (0.5).
    ids = await repo.top_track_ids_for_topic("bhakti", languages=[], limit=10)
    assert ids == ["t1", "t2", "t3"]


@pytest.mark.asyncio
async def test_top_track_ids_language_exists_filter(repo: SqliteCatalogRepository) -> None:
    # ru filter drops t2 (en-only); keeps t1 (ru+en) and t3 (ru).
    ids = await repo.top_track_ids_for_topic("bhakti", languages=["ru"], limit=10)
    assert ids == ["t1", "t3"]


@pytest.mark.asyncio
async def test_top_track_ids_limit(repo: SqliteCatalogRepository) -> None:
    ids = await repo.top_track_ids_for_topic("bhakti", languages=[], limit=1)
    assert ids == ["t1"]


@pytest.mark.asyncio
async def test_topic_names_lang_then_en_fallback(repo: SqliteCatalogRepository) -> None:
    # bhakti has ru; karma has only en → en fallback.
    names = await repo.topic_names(["bhakti", "karma"], lang="ru")
    assert names == {"bhakti": "Бхакти", "karma": "Karma"}


@pytest.mark.asyncio
async def test_topic_names_empty_input(repo: SqliteCatalogRepository) -> None:
    assert await repo.topic_names([], lang="ru") == {}
