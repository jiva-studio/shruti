"""Concurrent resolve reads while the catalog file is swapped repeatedly.

Readers on worker threads never fail and only ever see a name some catalog
file held; once the swaps stop, every reader sees the last file's rows.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path

from shruti_chat.infra.repositories import catalog_dictionary as repo

_SWAPS = 8
_READERS = 6


def _write_catalog(path: Path, author: str) -> None:
    with closing(sqlite3.connect(path)) as c:
        c.execute("CREATE TABLE authors (id TEXT, full_name TEXT, language TEXT)")
        c.execute("INSERT INTO authors VALUES ('a1', ?, 'en')", (author,))
        c.commit()


def _names(db: Path) -> list[str]:
    return [r.full_name for r in repo.load_dict(db, "authors", "en", [])]


def test_reads_during_repeated_swaps_converge_on_the_last_file(tmp_path: Path) -> None:
    db = tmp_path / "catalog.db"
    _write_catalog(db, "name-0")
    allowed = {f"name-{i}" for i in range(_SWAPS + 1)}
    stop = threading.Event()
    errors: list[BaseException] = []
    seen: set[str] = set()

    def read_loop() -> None:
        while not stop.is_set():
            try:
                names = _names(db)
            except BaseException as exc:  # noqa: BLE001 — collected for the assertion
                errors.append(exc)
                return
            if len(names) != 1 or names[0] not in allowed:
                errors.append(AssertionError(f"unexpected rows {names!r}"))
                return
            seen.add(names[0])

    readers = [threading.Thread(target=read_loop) for _ in range(_READERS)]
    for r in readers:
        r.start()
    try:
        for i in range(1, _SWAPS + 1):
            fresh = tmp_path / f"fresh-{i}.db"
            _write_catalog(fresh, f"name-{i}")
            # Distinct mtimes: the signature is (inode, mtime_ns, size).
            time.sleep(0.02)
            os.replace(fresh, db)
    finally:
        stop.set()
        for r in readers:
            r.join(timeout=10)

    assert not errors, errors
    assert len(seen) > 1
    assert _names(db) == [f"name-{_SWAPS}"]
