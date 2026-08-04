import sqlite3

import pytest

from shruti_chat.indexer.library.db import _verify_library_file

REQUIRED = [
    "library_verses",
    "library_documents",
    "library_document_variants",
    "library_titles",
]


def _build(path, variants_as_view: bool) -> None:
    conn = sqlite3.connect(path)
    for name in REQUIRED:
        conn.execute(f"CREATE TABLE {name} (id TEXT)")
    if variants_as_view:
        conn.execute(
            "CREATE TABLE library_verse_translations "
            "(verse_id TEXT, language TEXT, translation TEXT, kind TEXT)")
        conn.execute(
            "CREATE VIEW library_verse_variants AS "
            "SELECT verse_id, language, translation FROM library_verse_translations "
            "WHERE kind = 'canonical'")
    else:
        conn.execute(
            "CREATE TABLE library_verse_variants "
            "(verse_id TEXT, language TEXT, translation TEXT)")
    conn.commit()
    conn.close()


def test_accepts_variants_as_table(tmp_path):
    db = tmp_path / "library.db"
    _build(db, variants_as_view=False)
    _verify_library_file(db)


def test_accepts_variants_as_view(tmp_path):
    """Post word-by-word migration the name survives only as a compat view."""
    db = tmp_path / "library.db"
    _build(db, variants_as_view=True)
    _verify_library_file(db)


def test_rejects_missing_name(tmp_path):
    db = tmp_path / "library.db"
    conn = sqlite3.connect(db)
    for name in REQUIRED:
        conn.execute(f"CREATE TABLE {name} (id TEXT)")
    conn.commit()
    conn.close()
    with pytest.raises(RuntimeError, match="library_verse_variants"):
        _verify_library_file(db)
