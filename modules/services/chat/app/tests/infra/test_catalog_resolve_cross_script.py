"""`resolve` hands back the name that MATCHED, across a multi-locale dictionary.

The dictionary holds one row per locale for the same entity. When a caller
resolves with `lang=None` — which is how a lecture search finds an author whose
name the user typed in another script — the pool contains both, and the entity
that comes back must carry the name the query actually matched.

Production symptom when it doesn't: «есть лекции Шрилы Прабхупады?» is routed
with `author="Srila Prabhupada"`, the English row scores 77 and wins the
ranking, but the returned entity carries «А. Ч. Бхактиведанта Свами Прабхупада».
The caller's cross-script check then compares Latin against Cyrillic, decides
the corpus has no such teacher, and answers «лекций Шрилы Прабхупады не
найдено» — with the lectures sitting right there in the catalog.

Real SQLite, real dictionary shape: the worker-level fakes hold one row per
entity, which is exactly the shape that cannot reproduce this.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from lectorium_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
)


_EN = "A. C. Bhaktivedanta Swami Prabhupada"
_RU = "А. Ч. Бхактиведанта Свами Прабхупада"


def _make_catalog(path: Path) -> None:
    with sqlite3.connect(path) as c:
        c.executescript(
            """
            CREATE TABLE authors (
                id TEXT, language TEXT, full_name TEXT,
                PRIMARY KEY (id, language));
            CREATE TABLE sources (
                id TEXT, language TEXT, full_name TEXT, short_name TEXT,
                PRIMARY KEY (id, language));
            """
        )
        # Row order matters to the defect: the Russian row is inserted LAST, so
        # a lookup keyed by id alone returns it regardless of what matched.
        c.executemany(
            "INSERT INTO authors VALUES (?, ?, ?)",
            [
                ("author_prabhupada", "en", _EN),
                ("author_prabhupada", "ru", _RU),
                ("author_bvt", "en", "Śrīla Bhaktivinoda Ṭhākura"),
                ("author_bvt", "ru", "Шрила Бхактивинода Тхакур"),
            ],
        )
        c.executemany(
            "INSERT INTO sources VALUES (?, ?, ?, ?)",
            [
                ("source_bg", "en", "Bhagavad-gita As It Is", "BG"),
                ("source_bg", "ru", "Бхагавад-гита как она есть", "БГ"),
            ],
        )


@pytest.fixture
def repo(tmp_path: Path) -> SqliteCatalogRepository:
    db = tmp_path / "catalog.db"
    _make_catalog(db)
    return SqliteCatalogRepository(catalog_db_path=db)


async def test_a_latin_query_comes_back_with_the_latin_name(repo) -> None:
    hits = await repo.resolve("author", "Srila Prabhupada", lang=None, limit=5)
    assert hits
    assert hits[0].id == "author_prabhupada"
    # The whole point: not the Cyrillic row that merely shares the id.
    assert hits[0].full_name == _EN


async def test_a_cyrillic_query_comes_back_with_the_cyrillic_name(repo) -> None:
    hits = await repo.resolve("author", "Шрила Прабхупада", lang=None, limit=5)
    assert hits
    assert hits[0].id == "author_prabhupada"
    assert hits[0].full_name == _RU


async def test_asking_for_one_locale_still_answers_in_it(repo) -> None:
    # The single-locale callers (per-language dictionaries) are unaffected.
    hits = await repo.resolve("author", "Прабхупада", lang="ru", limit=5)
    assert hits and hits[0].full_name == _RU
    hits = await repo.resolve("author", "Prabhupada", lang="en", limit=5)
    assert hits and hits[0].full_name == _EN


async def test_the_right_entity_still_wins_over_a_near_miss(repo) -> None:
    # Ranking is unchanged — only WHICH row of the winner is returned.
    hits = await repo.resolve("author", "Bhaktivinoda", lang=None, limit=5)
    assert hits[0].id == "author_bvt"


async def test_an_abbreviation_match_returns_its_own_locale_row(repo) -> None:
    # Sources carry a `short_name` as a second matchable string per row, so the
    # same collapse could hand back the other locale's abbreviation.
    hits = await repo.resolve("source", "БГ", lang=None, limit=5)
    assert hits and hits[0].id == "source_bg"
    assert hits[0].extra.get("short_name") == "БГ"

    hits = await repo.resolve("source", "BG", lang=None, limit=5)
    assert hits and hits[0].extra.get("short_name") == "BG"
