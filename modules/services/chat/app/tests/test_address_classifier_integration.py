"""Integration test: AddressClassifier end-to-end against REAL SQLite.

Drives the classifier through the real SqliteCatalogRepository (fuzzy source
resolution + short_name matching) and the real `fetch_verse_body` existence
check over temp catalog + library DBs — proving the DB-coupled path, not just
the fakes in test_address_classifier.py.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from lectorium_chat.agent.classify.address import AddressClassifier
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
    invalidate_dict_cache,
)

_SOURCES = [
    # (id, language, short_name, full_name)
    ("src_bg", "ru", "БГ", "Бхагавад-гита"),
    ("src_bg", "en", "BG", "Bhagavad-gita"),
    ("src_sb", "ru", "ШБ", "Шримад-Бхагаватам"),
    ("src_sb", "en", "SB", "Śrīmad-Bhāgavatam"),
    ("src_ccm", "ru", "ЧЧ Мадхйа", "Чайтанья-чаритамрита, Мадхья-лила"),
    ("src_ccm", "en", "CC Madhya", "Caitanya-caritamrita, Madhya-lila"),
    ("src_cca", "ru", "ЧЧ Ади", "Чайтанья-чаритамрита, Ади-лила"),
    ("src_cca", "en", "CC Adi", "Caitanya-caritamrita, Adi-lila"),
]

# (id, source_id, tokens) — note 17.80 exists in BOTH CC lilas (the real-data
# trap that makes a dropped lila unrecoverable).
_VERSES = [
    ("v_bg_213", "src_bg", "2.13"),
    ("v_sb_111", "src_sb", "1.1.1"),
    ("v_ccm_1780", "src_ccm", "17.80"),
    ("v_cca_1780", "src_cca", "17.80"),
]


@pytest.fixture()
def ctx(tmp_path: Path) -> TurnContext:
    cat = tmp_path / "catalog.db"
    with sqlite3.connect(cat) as c:
        c.execute(
            "CREATE TABLE sources (id TEXT, language TEXT, short_name TEXT, full_name TEXT)"
        )
        c.executemany("INSERT INTO sources VALUES (?,?,?,?)", _SOURCES)

    lib = tmp_path / "library.db"
    with sqlite3.connect(lib) as c:
        c.execute(
            "CREATE TABLE library_verses ("
            "id TEXT PRIMARY KEY, source_id TEXT, tokens TEXT, "
            "text TEXT, transliteration TEXT, audio_path TEXT, "
            "UNIQUE(source_id, tokens))"
        )
        c.executemany(
            "INSERT INTO library_verses (id, source_id, tokens) VALUES (?,?,?)",
            _VERSES,
        )
        # fetch_verse_body joins variants for the card translation; the table
        # must exist even if empty (existence only needs the verse row).
        c.execute(
            "CREATE TABLE library_verse_variants ("
            "verse_id TEXT, language TEXT, translation TEXT, "
            "PRIMARY KEY (verse_id, language))"
        )

    invalidate_dict_cache()  # the dict cache is keyed (table, lang) — not by db path
    return TurnContext(
        catalog_repo=SqliteCatalogRepository(catalog_db_path=cat),
        library_db_path=lib,
        lang="ru",
    )


@pytest.mark.asyncio
async def test_madhya_lila_reference_case(ctx: TurnContext) -> None:
    """The Langfuse reference case: the lila in the raw query disambiguates
    CC Madhya from CC Adi (both have 17.80)."""
    d = await AddressClassifier().classify("Мадхья лила 17.80", ctx)
    assert d is not None and d.intent == "show_verse"
    assert d.extracted_args == {"source_id": "src_ccm", "tokens": "17.80"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query, source_id, tokens",
    [
        ("БГ 2.13", "src_bg", "2.13"),
        ("BG 2.13", "src_bg", "2.13"),
        ("Гита 2.13", "src_bg", "2.13"),          # fuzzy full-name
        ("1.1.1", "src_sb", "1.1.1"),             # structural default 3-level → SB
        ("ШБ 5 5 3" if False else "SB 1.1.1", "src_sb", "1.1.1"),
        ("ЧЧ Мадхья 17.80", "src_ccm", "17.80"),  # typo я→й, fuzzy
    ],
)
async def test_resolves_show_verse(ctx: TurnContext, query, source_id, tokens) -> None:
    d = await AddressClassifier().classify(query, ctx)
    assert d is not None and d.intent == "show_verse"
    assert d.extracted_args == {"source_id": source_id, "tokens": tokens}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query",
    [
        "что значит BG 2.13",   # question → research
        "что такое карма",      # no number → research
        "ШБ 99.99.99",          # no such verse
        "ЧЧ 17.80",             # bare CC: ambiguous (Adi + Madhya both have it)
    ],
)
async def test_defers_to_llm(ctx: TurnContext, query) -> None:
    assert await AddressClassifier().classify(query, ctx) is None
