"""Read-only connections to the catalog SQLite, through a `/dev/shm` mirror.

The catalog file is replaced by the indexer with `os.replace`; every helper
here keys on the file's stat signature, so a swapped file is picked up by the
next connection without an explicit invalidation.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


# On Linux containers `/dev/shm` is a tmpfs — files written there live
# entirely in RAM. The catalog DB is small (~50 MB) and read-only between
# indexer swaps, so mirroring it to /dev/shm eliminates every page-cache
# miss without giving up multi-connection concurrency (a single
# in-memory connection with check_same_thread=False would serialise
# every catalog read behind a global lock and kill fanout parallelism).
#
# The mirror is refreshed lazily by comparing inode + mtime + size; the
# indexer's atomic `os.replace` of the on-disk DB changes the inode,
# which is what we watch. No explicit invalidate hook required.

_SHM_DIR = Path("/dev/shm")
_mirror_lock = threading.Lock()
# (source_path, source_stat_signature) -> mirror_path
_mirror_cache: dict[tuple[str, tuple[int, int, int]], Path] = {}


def stat_signature(path: Path) -> tuple[int, int, int] | None:
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    # ino + mtime_ns + size: changes on indexer swap (new inode) and on
    # in-place rewrites that preserve the inode (mtime + size move).
    return (st.st_ino, st.st_mtime_ns, st.st_size)


def mirror_path_for(source: Path) -> Path:
    """Return a `/dev/shm` mirror of `source`, copying on first call and
    on every source change. Falls back to `source` itself if /dev/shm
    isn't writable (macOS dev hosts) — behaviour is unchanged there."""
    sig = stat_signature(source)
    if sig is None:
        return source
    key = (str(source), sig)
    cached = _mirror_cache.get(key)
    if cached is not None and cached.exists():
        return cached
    if not _SHM_DIR.exists() or not os.access(_SHM_DIR, os.W_OK):
        return source
    with _mirror_lock:
        cached = _mirror_cache.get(key)
        if cached is not None and cached.exists():
            return cached
        # Use a stable name keyed on source-path hash + pid so multiple
        # workers in the same container don't trample each other.
        suffix = source.name.replace(os.sep, "_")
        mirror = _SHM_DIR / f"shruti_catalog_{os.getpid()}_{suffix}"
        tmp = mirror.with_suffix(mirror.suffix + ".tmp")
        try:
            shutil.copy2(source, tmp)
            os.replace(tmp, mirror)
        except OSError:
            # No space in /dev/shm or any other tmpfs issue — give up on
            # the mirror, the on-disk path still works.
            tmp.unlink(missing_ok=True)
            return source
        # Drop stale mirrors for the SAME source path so we don't leak
        # /dev/shm space on every indexer swap.
        for stale_key in [k for k in _mirror_cache if k[0] == str(source) and k != key]:
            stale = _mirror_cache.pop(stale_key, None)
            if stale and stale != mirror:
                stale.unlink(missing_ok=True)
        _mirror_cache[key] = mirror
        return mirror


@contextmanager
def catalog_conn(path: Path) -> Iterator[sqlite3.Connection]:
    if not path.exists():
        raise RuntimeError(
            f"catalog DB not found at {path}; indexer not bootstrapped"
        )
    effective = mirror_path_for(path)
    uri = f"file:{effective}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    # mmap_size lets SQLite use mmap on the underlying file. For an
    # already-in-RAM /dev/shm mirror this is essentially free; for the
    # fallback path it gives the kernel a hint to keep pages hot.
    try:
        conn.execute("PRAGMA mmap_size = 67108864")  # 64 MB
    except sqlite3.OperationalError:
        # Some builds don't support mmap; harmless to skip.
        pass
    try:
        yield conn
    finally:
        conn.close()
