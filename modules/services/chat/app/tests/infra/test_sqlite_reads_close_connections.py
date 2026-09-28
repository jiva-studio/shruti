"""Every read-only SQLite helper closes its connection before returning.

`with sqlite3.connect(...) as conn` only ends the transaction; the
connection — and the inode of a catalog or library file the indexer has
since replaced — stays open until garbage collection. These helpers run on
every chat turn and every indexer pass, so each must close what it opens.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from shruti_chat.indexer import _swap
from shruti_chat.indexer.library import attribution_indexer, chunker
from shruti_chat.infra.repositories import sqlite_library_repository as lib_repo
from shruti_chat.observability import auto_scores

_SCHEMA = [
    "CREATE TABLE library_verses (id TEXT, source_id TEXT, tokens TEXT, text TEXT,"
    " transliteration TEXT, audio_path TEXT)",
    "CREATE TABLE library_verse_variants (verse_id TEXT, language TEXT, translation TEXT)",
    "CREATE TABLE library_documents (id TEXT, source_id TEXT, tokens TEXT,"
    " author_id TEXT, kind TEXT, date TEXT)",
    "CREATE TABLE library_document_variants (document_id TEXT, language TEXT,"
    " title TEXT, body TEXT)",
    "CREATE TABLE library_titles (source_id TEXT, tokens TEXT, language TEXT, title TEXT)",
    "CREATE TABLE library_media (id TEXT, lang TEXT, title TEXT, text TEXT, context TEXT,"
    " embed_text TEXT, url TEXT, type TEXT, meta TEXT)",
    "CREATE TABLE library_attributions (id TEXT, kind TEXT)",
    "CREATE TABLE library_attribution_triggers (attribution_id TEXT, language TEXT, text TEXT)",
    "CREATE TABLE library_attribution_notes (attribution_id TEXT, language TEXT, note TEXT)",
    "CREATE TABLE library_attribution_refs (attribution_id TEXT, ref_kind TEXT,"
    " target_id TEXT, language TEXT, position INTEGER)",
    "CREATE TABLE sources (id TEXT, language TEXT, short_name TEXT)",
]


@pytest.fixture()
def db(tmp_path: Path) -> Path:
    path = tmp_path / "library.db"
    with closing(sqlite3.connect(path)) as c:
        for stmt in _SCHEMA:
            c.execute(stmt)
        c.commit()
    return path


@pytest.fixture()
def opened(monkeypatch) -> list[sqlite3.Connection]:
    conns: list[sqlite3.Connection] = []
    real = sqlite3.connect

    def _tracking(*a, **kw):
        conn = real(*a, **kw)
        conns.append(conn)
        return conn

    monkeypatch.setattr(sqlite3, "connect", _tracking)
    return conns


_READS = {
    "verse_body": lambda p: lib_repo._fetch_verse_body_sync(p, "s", "1"),
    "verse_commentary": lambda p: lib_repo._fetch_verse_commentary_sync(p, "s", "1", "en"),
    "titles": lambda p: lib_repo._fetch_titles_sync(p, "s", "", "en"),
    "document_body": lambda p: lib_repo._fetch_document_body_sync(p, "d", "en"),
    "media": lambda p: lib_repo._fetch_media_sync(p, "m"),
    "missing_verses": lambda p: auto_scores._count_missing_verses(p, [("s", "1")]),
    "source_short_names": lambda p: chunker.load_source_short_names(p),
    "walk_verses": lambda p: list(chunker.walk_verses(p, {}, langs=["en"])),
    "walk_titles": lambda p: list(chunker.walk_titles(p, {}, langs=["en"])),
    "walk_documents": lambda p: list(chunker.walk_documents(p, {}, langs=["en"])),
    "walk_media": lambda p: list(chunker.walk_media(p, langs=["en"])),
    "walk_attributions": lambda p: attribution_indexer._walk_attributions(p),
    "table_names": lambda p: _swap.read_table_names(p, ("table",)),
}


@pytest.mark.parametrize("name", sorted(_READS))
def test_read_closes_its_connection(name: str, db: Path, opened) -> None:
    _READS[name](db)
    assert opened, "the helper did not open a connection"
    for conn in opened:
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            conn.execute("SELECT 1")
