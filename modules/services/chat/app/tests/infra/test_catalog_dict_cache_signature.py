"""The resolve dictionary cache never serves rows from a replaced catalog file.

The indexer swaps `catalog.db` with `os.replace`; the cache is keyed by the
file's stat signature, so both a swap nobody announced and a swap that lands
while a load is in flight must be read fresh on the next call.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from pathlib import Path

from shruti_chat.infra.repositories import catalog_dictionary as repo


def _write_catalog(path: Path, author: str) -> None:
    with closing(sqlite3.connect(path)) as c:
        c.execute("CREATE TABLE authors (id TEXT, full_name TEXT, language TEXT)")
        c.execute("INSERT INTO authors VALUES ('a1', ?, 'en')", (author,))
        c.commit()


def _swap(target: Path, author: str) -> None:
    fresh = target.with_name("fresh.db")
    _write_catalog(fresh, author)
    os.replace(fresh, target)


def _names(db: Path) -> list[str]:
    return [r.full_name for r in repo.load_dict(db, "authors", "en", [])]


def test_swapped_file_is_reloaded_without_invalidation(tmp_path: Path) -> None:
    db = tmp_path / "catalog.db"
    _write_catalog(db, "Old Name")
    assert _names(db) == ["Old Name"]

    _swap(db, "New Name")

    assert _names(db) == ["New Name"]


def test_swap_during_load_does_not_cache_old_rows(tmp_path: Path, monkeypatch) -> None:
    """A load that read the old file finishes after the swap and the
    indexer's invalidation — its rows must not become the cached answer."""
    db = tmp_path / "catalog.db"
    _write_catalog(db, "Old Name")
    real_conn = repo.catalog_conn
    swapped = False

    class _SwapAfterRead:
        def __init__(self, path: Path) -> None:
            self._cm = real_conn(path)

        def __enter__(self):
            conn = self._cm.__enter__()
            outer = self

            class _Conn:
                def execute(self, *a):
                    rows = conn.execute(*a).fetchall()
                    outer.swap_once()
                    return _Rows(rows)

            return _Conn()

        def swap_once(self) -> None:
            nonlocal swapped
            if not swapped:
                swapped = True
                _swap(db, "New Name")
                repo.invalidate_dict_cache()

        def __exit__(self, *exc):
            return self._cm.__exit__(*exc)

    class _Rows:
        def __init__(self, rows) -> None:
            self._rows = rows

        def fetchall(self):
            return self._rows

    monkeypatch.setattr(repo, "catalog_conn", _SwapAfterRead)

    assert _names(db) == ["Old Name"]  # this load read the old file
    assert _names(db) == ["New Name"]


def test_reload_after_swap_drops_entries_of_the_replaced_file(tmp_path: Path) -> None:
    db = tmp_path / "catalog.db"
    _write_catalog(db, "Old Name")
    _names(db)
    _swap(db, "New Name")
    _names(db)

    signatures = {k.signature for k in repo._cache if k.db_path == str(db)}
    assert signatures == {repo.stat_signature(db)}
