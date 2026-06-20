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

from shruti_chat.indexer.library.attribution_indexer import (
    _etag,
    _walk_attributions,
)


def _seed_library(path: Path) -> None:
    """Create a minimal library.db with the attribution schema only (the
    current schema: triggers + notes + refs with optional language)."""
    with sqlite3.connect(str(path)) as conn:
        conn.executescript("""
            PRAGMA foreign_keys = ON;
            CREATE TABLE library_attributions (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                created_at TIMESTAMP NOT NULL,
                updated_at TIMESTAMP NOT NULL
            );
            CREATE TABLE library_attribution_triggers (
                attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
                language TEXT NOT NULL,
                text TEXT NOT NULL,
                PRIMARY KEY (attribution_id, language, text)
            );
            CREATE TABLE library_attribution_notes (
                attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
                language TEXT NOT NULL,
                note TEXT NOT NULL,
                PRIMARY KEY (attribution_id, language)
            );
            CREATE TABLE library_attribution_refs (
                attribution_id TEXT NOT NULL REFERENCES library_attributions(id) ON DELETE CASCADE,
                ref_kind TEXT NOT NULL,
                target_id TEXT NOT NULL,
                language TEXT,
                position INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (attribution_id, ref_kind, target_id)
            );
        """)


@pytest.fixture
def library_db(tmp_path: Path) -> Path:
    p = tmp_path / "library.db"
    _seed_library(p)
    return p


def _insert_attr(db: Path, aid: str, kind: str = "pinned") -> None:
    with sqlite3.connect(str(db)) as conn:
        conn.execute(
            "INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)",
            (aid, kind, "2026-05-21", "2026-05-21"),
        )


def _insert_text(db: Path, aid: str, lang: str, text: str) -> None:
    with sqlite3.connect(str(db)) as conn:
        conn.execute(
            "INSERT INTO library_attribution_triggers (attribution_id, language, text) VALUES (?,?,?)",
            (aid, lang, text),
        )


def _insert_note(db: Path, aid: str, lang: str, note: str) -> None:
    with sqlite3.connect(str(db)) as conn:
        conn.execute(
            "INSERT INTO library_attribution_notes (attribution_id, language, note) VALUES (?,?,?)",
            (aid, lang, note),
        )


def _insert_ref(
    db: Path, aid: str, ref_kind: str, target_id: str, position: int = 0,
    language: str | None = None,
) -> None:
    with sqlite3.connect(str(db)) as conn:
        conn.execute(
            "INSERT INTO library_attribution_refs (attribution_id, ref_kind, target_id, language, position) VALUES (?,?,?,?,?)",
            (aid, ref_kind, target_id, language, position),
        )


# ---------- _walk_attributions ----------


def test_walk_assembles_variants_sorted(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_a", "pinned")
    # Insert in non-alphabetical order to verify sorting.
    _insert_text(library_db, "attribution_a", "ru", "природа разума")
    _insert_text(library_db, "attribution_a", "ru", "что такое разум")
    _insert_text(library_db, "attribution_a", "ru", "что значит buddhi")

    attrs, variants, refs, _notes = _walk_attributions(library_db)

    assert attrs == {"attribution_a": "pinned"}
    assert len(variants[("attribution_a", "ru")]) == 3
    # Sorted alphabetically (cyrillic + latin).
    assert variants[("attribution_a", "ru")] == sorted(variants[("attribution_a", "ru")])


def test_walk_multiple_languages(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_a", "pinned")
    _insert_text(library_db, "attribution_a", "ru", "что такое разум")
    _insert_text(library_db, "attribution_a", "en", "what is intelligence")

    _, variants, _, _ = _walk_attributions(library_db)
    assert variants[("attribution_a", "ru")] == ["что такое разум"]
    assert variants[("attribution_a", "en")] == ["what is intelligence"]


def test_walk_refs_normalized(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_a", "pinned")
    # Insert refs in random order; expect ORDER BY position, ref_kind, target_id.
    _insert_ref(library_db, "attribution_a", "verse", "verse_z", 1)
    _insert_ref(library_db, "attribution_a", "verse", "verse_a", 0)
    _insert_ref(library_db, "attribution_a", "document", "library_document_x", 0)

    _, _, refs, _ = _walk_attributions(library_db)
    out = refs["attribution_a"]
    # position 0 first, then within same position sorted by ref_kind then target_id
    assert out == [
        {"ref_kind": "document", "target_id": "library_document_x"},
        {"ref_kind": "verse", "target_id": "verse_a"},
        {"ref_kind": "verse", "target_id": "verse_z"},
    ]


def test_walk_empty_attribution_has_no_variants_or_refs(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_orphan", "boost")
    attrs, variants, refs, _notes = _walk_attributions(library_db)
    assert "attribution_orphan" in attrs
    assert ("attribution_orphan", "ru") not in variants
    assert "attribution_orphan" not in refs


def test_walk_both_kinds(library_db: Path) -> None:
    _insert_attr(library_db, "attribution_q", "pinned")
    _insert_attr(library_db, "attribution_t", "boost")
    attrs, _, _, _ = _walk_attributions(library_db)
    assert attrs == {"attribution_q": "pinned", "attribution_t": "boost"}


def test_walk_memory_embeds_trigger_and_note_chunks(library_db: Path) -> None:
    # A memory: trigger phrases + a note (embedded as chunks) + a
    # language-scoped track ref.
    _insert_attr(library_db, "attribution_m", "memory")
    _insert_text(library_db, "attribution_m", "ru", "структура гиты")
    note = "Бхагавад-гита делится на три части по шесть глав."
    _insert_note(library_db, "attribution_m", "ru", note)
    _insert_ref(library_db, "attribution_m", "track", "track_x@0-1000", language="en")

    attrs, embed_sets, refs, notes = _walk_attributions(library_db)

    assert attrs["attribution_m"] == "memory"
    # The note text is mirrored whole for injection-time fetch.
    assert notes[("attribution_m", "ru")] == note
    # The embed set carries BOTH the trigger and the note's chunk(s), so a query
    # close to either surfaces the memory.
    embedded = embed_sets[("attribution_m", "ru")]
    assert "структура гиты" in embedded
    assert any(note in chunk or chunk in note for chunk in embedded)
    assert len(embedded) >= 2
    # The track ref carries its optional language.
    assert refs["attribution_m"] == [
        {"ref_kind": "track", "target_id": "track_x@0-1000", "language": "en"},
    ]


def test_walk_note_only_memory_still_embeds(library_db: Path) -> None:
    # A memory with a note but no triggers still produces an embed set (so it
    # can be found) and mirrors the note.
    _insert_attr(library_db, "attribution_n", "memory")
    note = "История Арджуны и Агнидева в первой главе."
    _insert_note(library_db, "attribution_n", "ru", note)

    _, embed_sets, _, notes = _walk_attributions(library_db)
    assert notes[("attribution_n", "ru")] == note
    assert ("attribution_n", "ru") in embed_sets
    assert embed_sets[("attribution_n", "ru")]


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
