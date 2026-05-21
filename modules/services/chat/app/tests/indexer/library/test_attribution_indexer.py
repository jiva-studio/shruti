"""Unit tests for the pure (non-Postgres) parts of attribution_indexer.

Database-backed tests live in tests/integration/test_attribution_full_flow.py
where Postgres is bootstrapped via docker-compose. Here we cover:
  - SQLite walk: text variant assembly, sort stability, refs ordering
  - etag: stable across input reorder, changes on add / edit / remove
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from lectorium_chat.indexer.library.attribution_indexer import (
    _etag,
    _walk_attributions,
)


def _seed_library(path: Path) -> None:
    """Create a minimal library.db with the attribution schema only."""
    with sqlite3.connect(str(path)) as conn:
        conn.executescript("""
            PRAGMA foreign_keys = ON;
            CREATE TABLE library_attributions (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                created_at TIMESTAMP NOT NULL,
                updated_at TIMESTAMP NOT NULL
            );
            CREATE TABLE library_attribution_texts (
                attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
                language TEXT NOT NULL,
                text TEXT NOT NULL,
                PRIMARY KEY (attribution_id, language, text)
            );
            CREATE TABLE library_attribution_refs (
                attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
                ref_kind TEXT NOT NULL,
                target_id TEXT NOT NULL,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (attribution_id, ref_kind, target_id)
            );
        """)


@pytest.fixture
def library_db(tmp_path: Path) -> Path:
    p = tmp_path / "library.db"
    _seed_library(p)
    return p


def _insert_attr(db: Path, aid: str, kind: str = "question") -> None:
    with sqlite3.connect(str(db)) as conn:
        conn.execute(
            "INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)",
            (aid, kind, "2026-05-21", "2026-05-21"),
        )


def _insert_text(db: Path, aid: str, lang: str, text: str) -> None:
    with sqlite3.connect(str(db)) as conn:
        conn.execute(
            "INSERT INTO library_attribution_texts (attribution_id, language, text) VALUES (?,?,?)",
            (aid, lang, text),
        )


def _insert_ref(db: Path, aid: str, ref_kind: str, target_id: str, position: int = 0) -> None:
    with sqlite3.connect(str(db)) as conn:
        conn.execute(
            "INSERT INTO library_attribution_refs (attribution_id, ref_kind, target_id, position) VALUES (?,?,?,?)",
            (aid, ref_kind, target_id, position),
        )


# ---------- _walk_attributions ----------


def test_walk_assembles_variants_sorted(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_a", "question")
    # Insert in non-alphabetical order to verify sorting.
    _insert_text(library_db, "attribution_a", "ru", "природа разума")
    _insert_text(library_db, "attribution_a", "ru", "что такое разум")
    _insert_text(library_db, "attribution_a", "ru", "что значит buddhi")

    attrs, variants, refs = _walk_attributions(library_db)

    assert attrs == {"attribution_a": "question"}
    assert len(variants[("attribution_a", "ru")]) == 3
    # Sorted alphabetically (cyrillic + latin).
    assert variants[("attribution_a", "ru")] == sorted(variants[("attribution_a", "ru")])


def test_walk_multiple_languages(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_a", "question")
    _insert_text(library_db, "attribution_a", "ru", "что такое разум")
    _insert_text(library_db, "attribution_a", "en", "what is intelligence")

    _, variants, _ = _walk_attributions(library_db)
    assert variants[("attribution_a", "ru")] == ["что такое разум"]
    assert variants[("attribution_a", "en")] == ["what is intelligence"]


def test_walk_refs_normalized(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_a", "question")
    # Insert refs in random order; expect ORDER BY position, ref_kind, target_id.
    _insert_ref(library_db, "attribution_a", "verse", "verse_z", 1)
    _insert_ref(library_db, "attribution_a", "verse", "verse_a", 0)
    _insert_ref(library_db, "attribution_a", "document", "library_document_x", 0)

    _, _, refs = _walk_attributions(library_db)
    out = refs["attribution_a"]
    # position 0 first, then within same position sorted by ref_kind then target_id
    assert out == [
        {"ref_kind": "document", "target_id": "library_document_x"},
        {"ref_kind": "verse", "target_id": "verse_a"},
        {"ref_kind": "verse", "target_id": "verse_z"},
    ]


def test_walk_empty_attribution_has_no_variants_or_refs(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_orphan", "topic")
    attrs, variants, refs = _walk_attributions(library_db)
    assert "attribution_orphan" in attrs
    assert ("attribution_orphan", "ru") not in variants
    assert "attribution_orphan" not in refs


def test_walk_both_kinds(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_q", "question")
    _insert_attr(library_db, "attribution_t", "topic")
    attrs, _, _ = _walk_attributions(library_db)
    assert attrs == {"attribution_q": "question", "attribution_t": "topic"}


# ---------- _etag ----------


def test_etag_stable_across_reorder() -> None:
    a = _etag(["a", "b", "c"])
    b = _etag(["a", "b", "c"])
    assert a == b


def test_etag_changes_on_variant_add() -> None:
    a = _etag(["a", "b"])
    b = _etag(["a", "b", "c"])
    assert a != b


def test_etag_changes_on_text_edit() -> None:
    a = _etag(["что такое разум"])
    b = _etag(["что такое buddhi"])
    assert a != b


def test_etag_changes_on_variant_remove() -> None:
    a = _etag(["a", "b", "c"])
    b = _etag(["a", "b"])
    assert a != b


def test_etag_empty_list() -> None:
    # Edge case — should still return a hash, not raise.
    assert _etag([]) != ""
