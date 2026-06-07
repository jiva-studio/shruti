"""`fetch_verse_body` emits transliteration as a per-locale map.

`en` is the clean Latin IAST stored in library.db (source of truth);
`ru` is DERIVED on read via the IAST→Cyrillic transliterator. The SSE
layer later picks one string by the turn's locale.
"""

from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from shruti_chat.indexer.library.repo import fetch_verse_body

MACRON = "̄"
DOT_BELOW = "̣"


def _seed(path: Path) -> None:
    with sqlite3.connect(str(path)) as conn:
        conn.executescript(
            """
            CREATE TABLE library_verses (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                tokens TEXT NOT NULL,
                text TEXT,
                transliteration TEXT
            );
            CREATE TABLE library_verse_variants (
                verse_id TEXT NOT NULL,
                language TEXT NOT NULL,
                translation TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO library_verses VALUES (?,?,?,?,?)",
            ("v1", "src", "1.1", "देवनागरी", "dhṛtarāṣṭra uvāca"),
        )
        conn.execute(
            "INSERT INTO library_verses VALUES (?,?,?,?,?)",
            ("v2", "src", "1.2", "x", ""),  # no IAST
        )
        conn.executemany(
            "INSERT INTO library_verse_variants VALUES (?,?,?)",
            [("v1", "ru", "Дхритараштра сказал"), ("v1", "en", "Dhritarashtra said")],
        )
        conn.commit()


def test_transliteration_is_per_locale_map(tmp_path: Path):
    db = tmp_path / "library.db"
    _seed(db)
    body = asyncio.run(fetch_verse_body(db, "src", "1.1"))
    assert body is not None
    tr = body["transliteration"]
    # en is the IAST verbatim
    assert tr["en"] == "dhṛtarāṣṭra uvāca"
    # ru is the derived Cyrillic
    assert tr["ru"] == (
        "дхр" + DOT_BELOW + "тара" + MACRON + "шт" + DOT_BELOW + "ра ува" + MACRON + "ча"
    )
    assert body["translation"] == {
        "ru": "Дхритараштра сказал",
        "en": "Dhritarashtra said",
    }


def test_empty_iast_yields_empty_map(tmp_path: Path):
    db = tmp_path / "library.db"
    _seed(db)
    body = asyncio.run(fetch_verse_body(db, "src", "1.2"))
    assert body is not None
    assert body["transliteration"] == {}


def test_missing_verse_returns_none(tmp_path: Path):
    db = tmp_path / "library.db"
    _seed(db)
    assert asyncio.run(fetch_verse_body(db, "src", "9.9")) is None
