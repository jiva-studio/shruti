"""Tests for `_normalize_source_id` in `sqlite_catalog_repository`.

Production bug: router + catalog_worker chain passed `source_id="BG"`
(short name extracted from "Покажи лекции по БГ 2.13") to tracks_list,
but the catalog filter expects the opaque `source_<base62>` id. The
filter silently became no-op, tracks_list returned random unfiltered
tracks, synth saw topic mismatch and refused.

The normalizer accepts BOTH forms transparently — short_name lookups
hit the `sources` table (case-insensitive, multi-language), opaque
ids pass through.

These tests pin that behavior end-to-end against a real SQLite catalog
DB so the catalog short-name → opaque resolution can't silently
regress.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from shruti_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
    _normalize_source_id,
)


# ── catalog fixture: tiny in-process SQLite with one source + 3 tracks ──


_OPAQUE_BG = "source_dsicuBsFvinZ"
_OPAQUE_SB = "source_NoY8sAlXF1IT"


def _build_catalog(tmp_path: Path) -> Path:
    """Build a minimal catalog DB shaped like production: sources +
    tracks + track_variants + track_references, with two sources
    (BG/БГ, SB/ШБ) and three lectures — two referencing BG verses,
    one referencing SB."""
    db = tmp_path / "catalog.db"
    conn = sqlite3.connect(db)
    conn.executescript(
        """
        CREATE TABLE sources (
            id TEXT NOT NULL,
            language TEXT NOT NULL,
            full_name TEXT NOT NULL,
            short_name TEXT NOT NULL,
            PRIMARY KEY (id, language)
        );
        CREATE TABLE tracks (
            id TEXT PRIMARY KEY,
            date TEXT,
            author_id TEXT,
            location_id TEXT,
            hidden INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE track_variants (
            track_id TEXT NOT NULL,
            language TEXT NOT NULL,
            title TEXT,
            audio_duration INTEGER,
            transcript_path TEXT,
            PRIMARY KEY (track_id, language)
        );
        CREATE TABLE track_references (
            track_id TEXT NOT NULL,
            ref_idx INTEGER NOT NULL,
            source_id TEXT NOT NULL,
            tokens TEXT
        );
        CREATE TABLE track_tags (
            track_id TEXT NOT NULL,
            tag_id TEXT NOT NULL
        );
        CREATE TABLE tags (
            id TEXT NOT NULL,
            language TEXT NOT NULL,
            full_name TEXT NOT NULL,
            PRIMARY KEY (id, language)
        );
        CREATE TABLE authors (
            id TEXT NOT NULL,
            language TEXT NOT NULL,
            full_name TEXT NOT NULL,
            PRIMARY KEY (id, language)
        );
        CREATE TABLE locations (
            id TEXT NOT NULL,
            language TEXT NOT NULL,
            full_name TEXT NOT NULL,
            PRIMARY KEY (id, language)
        );
        """
    )
    # Sources — BG in en + ru, SB in en + ru.
    conn.executemany(
        "INSERT INTO sources (id, language, full_name, short_name) VALUES (?,?,?,?)",
        [
            (_OPAQUE_BG, "en", "Bhagavad-gita", "BG"),
            (_OPAQUE_BG, "ru", "Бхагавад-гита", "БГ"),
            (_OPAQUE_SB, "en", "Srimad-Bhagavatam", "SB"),
            (_OPAQUE_SB, "ru", "Шримад-Бхагаватам", "ШБ"),
        ],
    )
    # Three lectures: track_A references BG 2.13, track_B references BG 4.17,
    # track_C references SB 5.5.3.
    conn.executemany(
        "INSERT INTO tracks (id, date, hidden) VALUES (?,?,0)",
        [
            ("track_A", "1973-08-26"),
            ("track_B", "1974-04-06"),
            ("track_C", "1976-10-20"),
        ],
    )
    conn.executemany(
        "INSERT INTO track_variants (track_id, language, title, audio_duration, transcript_path) "
        "VALUES (?,?,?,?,?)",
        [
            ("track_A", "ru", "Лекция по БГ 2.13", 1680000, "/tmp/a.txt"),
            ("track_B", "ru", "Лекция по БГ 4.17", 2200000, "/tmp/b.txt"),
            ("track_C", "ru", "Лекция по ШБ 5.5.3", 1900000, "/tmp/c.txt"),
        ],
    )
    conn.executemany(
        "INSERT INTO track_references (track_id, ref_idx, source_id, tokens) VALUES (?,?,?,?)",
        [
            ("track_A", 0, _OPAQUE_BG, "2.13"),
            ("track_B", 0, _OPAQUE_BG, "4.17"),
            ("track_C", 0, _OPAQUE_SB, "5.5.3"),
        ],
    )
    conn.commit()
    conn.close()
    return db


@pytest.fixture()
def catalog_db(tmp_path: Path) -> Path:
    return _build_catalog(tmp_path)


# ── _normalize_source_id direct unit tests ──────────────────────────


def test_normalize_returns_none_for_empty(catalog_db: Path) -> None:
    assert _normalize_source_id(catalog_db, None) is None
    assert _normalize_source_id(catalog_db, "") is None
    assert _normalize_source_id(catalog_db, "   ") is None


def test_normalize_passes_opaque_id_through(catalog_db: Path) -> None:
    """Already-opaque ids must round-trip unchanged — the normalizer is
    additive, never destructive."""
    assert _normalize_source_id(catalog_db, _OPAQUE_BG) == _OPAQUE_BG
    assert _normalize_source_id(catalog_db, _OPAQUE_SB) == _OPAQUE_SB


def test_normalize_resolves_english_short_name(catalog_db: Path) -> None:
    assert _normalize_source_id(catalog_db, "BG") == _OPAQUE_BG
    assert _normalize_source_id(catalog_db, "SB") == _OPAQUE_SB


def test_normalize_resolves_russian_short_name(catalog_db: Path) -> None:
    """Cyrillic short_names — `БГ` (БГ) and `ШБ` — must resolve to
    the same opaque id as their Latin twins."""
    assert _normalize_source_id(catalog_db, "БГ") == _OPAQUE_BG
    assert _normalize_source_id(catalog_db, "ШБ") == _OPAQUE_SB


def test_normalize_is_case_insensitive(catalog_db: Path) -> None:
    assert _normalize_source_id(catalog_db, "bg") == _OPAQUE_BG
    assert _normalize_source_id(catalog_db, "sb") == _OPAQUE_SB
    assert _normalize_source_id(catalog_db, "Bg") == _OPAQUE_BG


def test_normalize_unknown_short_name_returns_none(catalog_db: Path) -> None:
    """No match → return None so the caller silently drops the filter
    instead of returning zero rows (which would refuse a query that
    might match other filters)."""
    assert _normalize_source_id(catalog_db, "XX") is None
    assert _normalize_source_id(catalog_db, "Bhagavatam") is None


# ── End-to-end: tracks_list with short_name behaves like opaque id ──


def test_tracks_list_accepts_short_name_for_bg_verse(catalog_db: Path) -> None:
    """The production bug: `tracks_list(source_id="BG", ref_prefix="2",
    ref_from=13, ref_to=13)` returned zero rows because the "BG" filter
    didn't match opaque ids. After the fix, the call returns the same
    set as the explicitly-opaque call."""
    repo = SqliteCatalogRepository(catalog_db_path=catalog_db)

    via_short = asyncio.run(
        repo.list_tracks(
            author_id=None, source_id="BG", location_id=None, tag_ids=None,
            title_query=None, date_from=None, date_to=None, lang="ru",
            limit=20, offset=0,
            ref_prefix="2", ref_from=13, ref_to=13,
        )
    )
    via_opaque = asyncio.run(
        repo.list_tracks(
            author_id=None, source_id=_OPAQUE_BG, location_id=None, tag_ids=None,
            title_query=None, date_from=None, date_to=None, lang="ru",
            limit=20, offset=0,
            ref_prefix="2", ref_from=13, ref_to=13,
        )
    )
    short_ids = sorted(t.id for t in via_short)
    opaque_ids = sorted(t.id for t in via_opaque)
    assert short_ids == opaque_ids == ["track_A"]


def test_tracks_list_accepts_short_name_for_chapter_range(catalog_db: Path) -> None:
    """`tracks_list(source_id="БГ", ref_prefix="4", ref_from=15, ref_to=20)`
    must catch track_B (БГ 4.17). Covers the range-query use case
    'покажи лекции по второй главе с 10 по 15'."""
    repo = SqliteCatalogRepository(catalog_db_path=catalog_db)
    out = asyncio.run(
        repo.list_tracks(
            author_id=None, source_id="БГ", location_id=None, tag_ids=None,
            title_query=None, date_from=None, date_to=None, lang="ru",
            limit=20, offset=0,
            ref_prefix="4", ref_from=15, ref_to=20,
        )
    )
    assert [t.id for t in out] == ["track_B"]


def test_tracks_list_short_name_no_range_returns_all_for_source(
    catalog_db: Path,
) -> None:
    """`tracks_list(source_id="SB")` (no ref filter) returns every
    track that references that source — track_C only in this fixture."""
    repo = SqliteCatalogRepository(catalog_db_path=catalog_db)
    out = asyncio.run(
        repo.list_tracks(
            author_id=None, source_id="SB", location_id=None, tag_ids=None,
            title_query=None, date_from=None, date_to=None, lang="ru",
            limit=20, offset=0,
        )
    )
    assert [t.id for t in out] == ["track_C"]


def test_tracks_list_unknown_short_name_drops_filter(catalog_db: Path) -> None:
    """Unknown short_name → filter dropped, NOT a zero-result refusal.
    This guards against a future router accidentally extracting a
    nonsense source_id like "Bhagavatam" and the catalog returning
    empty instead of falling back to other filters (e.g. author).
    Here with no other filters, every track is returned."""
    repo = SqliteCatalogRepository(catalog_db_path=catalog_db)
    out = asyncio.run(
        repo.list_tracks(
            author_id=None, source_id="Bhagavatam-Purana", location_id=None,
            tag_ids=None, title_query=None, date_from=None, date_to=None,
            lang="ru", limit=20, offset=0,
        )
    )
    assert sorted(t.id for t in out) == ["track_A", "track_B", "track_C"]


# ── get_titles (research-panel lecture labels) ──────────────────────

def test_get_titles_batch_resolves(catalog_db: Path) -> None:
    repo = SqliteCatalogRepository(catalog_db_path=catalog_db)
    out = asyncio.run(repo.get_titles(["track_A", "track_C"], lang="ru"))
    assert out == {
        "track_A": "Лекция по БГ 2.13",
        "track_C": "Лекция по ШБ 5.5.3",
    }


def test_get_titles_omits_unknown_and_empty(catalog_db: Path) -> None:
    """Unknown ids are simply absent; an empty/blank input list → {}."""
    repo = SqliteCatalogRepository(catalog_db_path=catalog_db)
    out = asyncio.run(repo.get_titles(["track_A", "nope", ""], lang="ru"))
    assert out == {"track_A": "Лекция по БГ 2.13"}
    assert asyncio.run(repo.get_titles([], lang="ru")) == {}
