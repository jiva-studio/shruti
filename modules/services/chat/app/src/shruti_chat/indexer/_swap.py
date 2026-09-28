"""Download-verify-replace for the SQLite files the indexer swaps in.

Shared by `catalog.ensure_catalog` and `library.db.ensure_library`. The
download goes into a temp file created fresh for this call (`mkstemp` in the
target's filesystem, so the final `os.replace` stays an atomic rename); the
blocking verify and rename run in a worker thread so a large file does not
stall the event loop. The temp file is removed on every path that does not
end in the rename.

A swap is serialised twice: by an `asyncio.Lock` in its module within one
process, and by `advisory_swap_lock` — a Postgres session advisory lock —
across every process that shares the database.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import tempfile
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from contextlib import asynccontextmanager, closing, suppress
from pathlib import Path

from shruti_chat.db.client import get_pool

# Advisory-lock keys, one per swapped file. Arbitrary but fixed: every
# process that swaps the same file must use the same key.
CATALOG_SWAP_LOCK_KEY = 0x5348525449_01  # "SHRTI" + catalog
LIBRARY_SWAP_LOCK_KEY = 0x5348525449_02  # "SHRTI" + library


@asynccontextmanager
async def advisory_swap_lock(key: int) -> AsyncIterator[None]:
    """Hold the Postgres session advisory lock `key` for the body.

    Blocks until any other process holding it finishes its swap. The lock
    belongs to the pooled connection that took it, so a connection that may
    still hold it — cancelled mid-acquire, or an unlock that did not complete
    — is terminated rather than handed back to the pool, where it would keep
    every later swap waiting.
    """
    async with get_pool().acquire() as conn:
        try:
            await conn.execute("SELECT pg_advisory_lock($1)", key)
        except BaseException:
            conn.terminate()
            raise
        try:
            yield
        finally:
            try:
                await conn.execute("SELECT pg_advisory_unlock($1)", key)
            except BaseException:
                conn.terminate()
                raise


async def download_verify_replace(
    *,
    download: Callable[[Path], Awaitable[None]],
    verify: Callable[[Path], None],
    tmp_dir: Path,
    prefix: str,
    target: Path,
) -> None:
    tmp_dir.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=tmp_dir, prefix=prefix, suffix=".db")
    os.close(fd)
    tmp_path = Path(name)
    try:
        await download(tmp_path)
        await asyncio.to_thread(verify, tmp_path)
        await asyncio.to_thread(os.replace, tmp_path, target)
    finally:
        # Gone already after a successful rename; otherwise a partial or
        # rejected download that only this call knows the name of.
        with suppress(FileNotFoundError):
            tmp_path.unlink()


def read_table_names(path: Path, types: Iterable[str]) -> set[str]:
    """Names in `sqlite_master` of the given types, read-only."""
    kinds = tuple(types)
    placeholders = ", ".join("?" for _ in kinds)
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as conn:
        return {
            r[0]
            for r in conn.execute(
                f"SELECT name FROM sqlite_master WHERE type IN ({placeholders})", kinds
            )
        }
