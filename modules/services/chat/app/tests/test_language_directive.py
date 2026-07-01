"""The synthesizer's language directive must name the language, not pass a
bare locale code (a bare "sr-Latn" made the LLM answer in Russian on
planner-less paths like show_verse). The name comes from the catalog
`languages` table — our single source of truth, which auto-extends.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from shruti_chat.agent.prompts import build_prompt
from shruti_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
)


# ── build_prompt {{LANG_NAME}} substitution ──────────────────────────


def test_lang_name_substituted_into_language_directive() -> None:
    text = build_prompt(("language",), lang="sr-Latn", lang_name="Srpski")
    assert "Srpski" in text
    assert "{{LANG_NAME}}" not in text
    assert "sr-Latn" in text  # the raw code is still shown as the locale


def test_lang_name_falls_back_to_code_when_unresolved() -> None:
    text = build_prompt(("language",), lang="sr-Latn", lang_name=None)
    assert "{{LANG_NAME}}" not in text
    # With no name resolved, the placeholder degrades to the code.
    assert "sr-Latn" in text


# ── catalog language_name (real temp SQLite) ─────────────────────────


@pytest.fixture()
def repo(tmp_path: Path) -> SqliteCatalogRepository:
    db = tmp_path / "catalog.db"
    with sqlite3.connect(db) as c:
        c.execute("CREATE TABLE languages (code TEXT, full_name TEXT, icon TEXT)")
        c.executemany(
            "INSERT INTO languages (code, full_name) VALUES (?,?)",
            [("ru", "Русский"), ("sr-Latn", "Srpski"), ("hi", "हिन्दी"), ("es", "Español")],
        )
    return SqliteCatalogRepository(catalog_db_path=db)


@pytest.mark.asyncio
async def test_language_name_native(repo: SqliteCatalogRepository) -> None:
    assert await repo.language_name("sr-Latn") == "Srpski"
    assert await repo.language_name("hi") == "हिन्दी"
    assert await repo.language_name("es") == "Español"


@pytest.mark.asyncio
async def test_language_name_case_insensitive(repo: SqliteCatalogRepository) -> None:
    # Clients spell the script subtag inconsistently (`sr-cyrl` vs `sr-Latn`).
    # A case-sensitive miss returns None → bare-code directive → Russian drift.
    assert await repo.language_name("sr-latn") == "Srpski"
    assert await repo.language_name("SR-LATN") == "Srpski"
    assert await repo.language_name("RU") == "Русский"


@pytest.mark.asyncio
async def test_language_name_unknown_is_none(repo: SqliteCatalogRepository) -> None:
    assert await repo.language_name("zz") is None
