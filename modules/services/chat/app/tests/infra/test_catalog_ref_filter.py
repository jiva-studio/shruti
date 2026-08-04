"""`filter_track_ids` narrowed to a scripture reference.

`list_tracks` could already filter by chapter/canto; `filter_track_ids` — the
projection that constrains an ANN search — could not. So "лекции по БГ 10" ran
an unconstrained semantic search and returned whatever was closest, which in
production was chapter 9. Both now apply the SAME predicate, over a real
SQLite catalog rather than a fake.
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
            CREATE TABLE tracks (
                id TEXT PRIMARY KEY, author_id TEXT, location_id TEXT,
                date TEXT, hidden INTEGER DEFAULT 0);
            CREATE TABLE track_references (
                track_id TEXT, source_id TEXT, tokens TEXT);
            CREATE TABLE sources (
                id TEXT, language TEXT, full_name TEXT, short_name TEXT,
                PRIMARY KEY (id, language));

            INSERT INTO tracks VALUES
                ('bg_10_1', 'a1', NULL, '1975-01-01', 0),
                ('bg_10_8', 'a1', NULL, '1975-02-01', 0),
                ('bg_9_11', 'a1', NULL, '1975-03-01', 0),
                ('bg_9_11_hidden', 'a1', NULL, '1975-04-01', 1),
                ('sb_10_14', 'a2', NULL, '1976-01-01', 0),
                ('no_refs',  'a1', NULL, '1977-01-01', 0);
            INSERT INTO track_references VALUES
                ('bg_10_1',  'source_bg', '10.1'),
                ('bg_10_8',  'source_bg', '10.8-10.9'),
                ('bg_9_11',  'source_bg', '9.11'),
                ('bg_9_11_hidden', 'source_bg', '10.2'),
                ('sb_10_14', 'source_sb', '10.14.32');
            INSERT INTO sources VALUES
                ('source_bg', 'en', 'Bhagavad-gita', 'BG'),
                ('source_sb', 'en', 'Srimad-Bhagavatam', 'SB');
            """
        )


@pytest.fixture
def repo(tmp_path: Path) -> SqliteCatalogRepository:
    db = tmp_path / "catalog.db"
    _make_catalog(db)
    return SqliteCatalogRepository(catalog_db_path=db)


async def test_a_chapter_narrows_to_that_chapter(repo) -> None:
    ids = await repo.filter_track_ids(
        author_id=None, source_id="source_bg", location_id=None, tag_ids=None,
        date_from=None, date_to=None, ref_prefix="", ref_from=10, ref_to=10,
    )
    # The chapter-9 lecture is what production actually returned for this ask.
    assert sorted(ids) == ["bg_10_1", "bg_10_8"]


async def test_a_hidden_track_stays_hidden(repo) -> None:
    ids = await repo.filter_track_ids(
        author_id=None, source_id="source_bg", location_id=None, tag_ids=None,
        date_from=None, date_to=None, ref_prefix="", ref_from=10, ref_to=10,
    )
    assert "bg_9_11_hidden" not in ids


async def test_the_reference_composes_with_the_other_filters(repo) -> None:
    # An author with no chapter-10 lecture must come back empty, not fall back
    # to the whole chapter.
    ids = await repo.filter_track_ids(
        author_id="a2", source_id="source_bg", location_id=None, tag_ids=None,
        date_from=None, date_to=None, ref_prefix="", ref_from=10, ref_to=10,
    )
    assert ids == []


async def test_a_canto_narrows_across_three_levels(repo) -> None:
    ids = await repo.filter_track_ids(
        author_id=None, source_id="source_sb", location_id=None, tag_ids=None,
        date_from=None, date_to=None, ref_prefix="", ref_from=10, ref_to=10,
    )
    assert ids == ["sb_10_14"]


async def test_a_verse_range_covers_its_span(repo) -> None:
    # 10.8-10.9 must match a request for 10.9.
    ids = await repo.filter_track_ids(
        author_id=None, source_id="source_bg", location_id=None, tag_ids=None,
        date_from=None, date_to=None, ref_prefix="10", ref_from=9, ref_to=9,
    )
    assert ids == ["bg_10_8"]


async def test_no_reference_leaves_the_other_filters_untouched(repo) -> None:
    ids = await repo.filter_track_ids(
        author_id=None, source_id="source_bg", location_id=None, tag_ids=None,
        date_from=None, date_to=None,
    )
    assert sorted(ids) == ["bg_10_1", "bg_10_8", "bg_9_11"]


async def test_no_filter_at_all_still_means_no_constraint(repo) -> None:
    # None (not []) is the documented "skip the constraint" signal — returning
    # [] here would silently search nothing.
    assert await repo.filter_track_ids(
        author_id=None, source_id=None, location_id=None, tag_ids=None,
        date_from=None, date_to=None,
    ) is None


async def test_a_reference_alone_is_a_filter(repo) -> None:
    # No source, no author — just a chapter. Still a constraint, not "None".
    ids = await repo.filter_track_ids(
        author_id=None, source_id=None, location_id=None, tag_ids=None,
        date_from=None, date_to=None, ref_prefix="", ref_from=10, ref_to=10,
    )
    assert sorted(ids) == ["bg_10_1", "bg_10_8", "sb_10_14"]
