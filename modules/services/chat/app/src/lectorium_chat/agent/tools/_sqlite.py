"""Shared helpers for read-only SQLite access to the catalog.

We open a fresh connection per tool call. The catalog file may get
atomically swapped underneath; fresh connect() always sees the latest.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from lectorium_chat.config import get_settings


@contextmanager
def catalog_conn() -> Iterator[sqlite3.Connection]:
    path = get_settings().catalog_db_path
    if not path.exists():
        raise RuntimeError(f"catalog DB not found at {path}; indexer not bootstrapped")
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]
