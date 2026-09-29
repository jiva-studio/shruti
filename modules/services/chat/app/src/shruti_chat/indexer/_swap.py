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

import asyncpg

from shruti_chat.db.client import asyncpg_dsn
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

# Advisory-lock keys, one per swapped file. Arbitrary but fixed: every
# process that swaps the same file must use the same key.
CATALOG_SWAP_LOCK_KEY = 0x5348525449_01  # "SHRTI" + catalog
LIBRARY_SWAP_LOCK_KEY = 0x5348525449_02  # "SHRTI" + library

# Backoff between tries while another process holds the lock.
SWAP_LOCK_POLL_FIRST_S = 0.1
SWAP_LOCK_POLL_MAX_S = 5.0


async def _connect(dsn: str, command_timeout_s: float) -> asyncpg.Connection:
    return await asyncpg.connect(dsn=asyncpg_dsn(dsn), command_timeout=command_timeout_s)


@asynccontextmanager
async def advisory_swap_lock(
    key: int,
    *,
    dsn: str,
    wait_s: float,
    command_timeout_s: float,
    poll_first_s: float = SWAP_LOCK_POLL_FIRST_S,
    poll_max_s: float = SWAP_LOCK_POLL_MAX_S,
) -> AsyncIterator[None]:
    """Hold the Postgres session advisory lock `key` for the body.

    Waits up to `wait_s` for another process's swap, then raises TimeoutError.
    Each try is a non-blocking `pg_try_advisory_lock`, so no statement runs
    into `command_timeout_s` however long the other swap takes. The lock lives
    on a dedicated connection, not a pooled one: it is held for a whole
    download, and ending the session releases it on every exit path.
    """
    conn = await _connect(dsn, command_timeout_s)
    try:
        await _wait_for_lock(conn, key, wait_s, poll_first_s, poll_max_s)
        yield
    except BaseException:
        conn.terminate()
        raise
    try:
        await conn.close(timeout=command_timeout_s)
    except Exception as exc:  # the swap is done; the lock dies with the session
        log.warning("swap_lock_close_failed", key=key, error=repr(exc))
        conn.terminate()


async def _wait_for_lock(
    conn: asyncpg.Connection, key: int, wait_s: float, poll_first_s: float, poll_max_s: float,
) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait_s
    delay = poll_first_s
    while not await conn.fetchval("SELECT pg_try_advisory_lock($1)", key):
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise TimeoutError(f"swap lock {key:#x} still held after {wait_s}s")
        await asyncio.sleep(min(delay, remaining))
        delay = min(delay * 2, poll_max_s)


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
