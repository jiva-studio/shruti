"""Indexer GC must stay inside its lane and be atomic.

Two defects this covers:

- The chunk deletes were scoped by `(track_id|item_id, lang)` only, while the
  write paths scope by `embed_model` and `kind`. Retiring a public track could
  therefore delete a user's private `user_track` chunks that share the id.
- Both statements ran on a bare `pool.acquire()` with no transaction, so a
  crash between them left the chunks gone while `indexed_items` still claimed
  the item was indexed — invisible to the diff from then on, serving nothing.

`gc_would_prune_too_much` is the third rail: the callers already refuse to
prune on an EMPTY source listing (an earlier incident wiped the transcript
corpus that way), but a partially populated listing passes that guard and
loses data the same way.
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.indexer._gc import (
    _MAX_STALE_SHARE,
    _MIN_STALE_FOR_SHARE_CHECK,
    delete_stale_library_items,
    delete_stale_transcripts,
    gc_would_prune_too_much,
)


class _Txn:
    def __init__(self, conn: "_Conn") -> None:
        self._conn = conn

    async def __aenter__(self) -> "_Txn":
        self._conn.in_transaction = True
        return self

    async def __aexit__(self, *a: Any) -> None:
        self._conn.transaction_closed = True


class _Conn:
    def __init__(self) -> None:
        self.in_transaction = False
        self.transaction_closed = False
        self.calls: list[tuple[str, list]] = []

    def transaction(self) -> _Txn:
        return _Txn(self)

    async def executemany(self, sql: str, args: list) -> None:
        assert self.in_transaction, "GC statement ran outside a transaction"
        self.calls.append((" ".join(sql.split()), args))


class _Acquire:
    def __init__(self, conn: _Conn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _Conn:
        return self._conn

    async def __aexit__(self, *a: Any) -> None:
        return None


class _Pool:
    def __init__(self) -> None:
        self.conn = _Conn()

    def acquire(self) -> _Acquire:
        return _Acquire(self.conn)


# ── share guard ─────────────────────────────────────────────────────────


def test_small_removals_are_always_allowed() -> None:
    assert not gc_would_prune_too_much(1, 1000)
    assert not gc_would_prune_too_much(_MIN_STALE_FOR_SHARE_CHECK - 1, 20)


def test_a_large_share_of_the_corpus_is_refused() -> None:
    # A listing that came back half-populated: half the corpus reads as stale.
    assert gc_would_prune_too_much(500, 1000)


def test_a_plausible_share_is_allowed() -> None:
    below = int(1000 * _MAX_STALE_SHARE) - 1
    assert not gc_would_prune_too_much(below, 1000)


def test_a_tiny_corpus_is_not_share_checked() -> None:
    # 2 of 3 is 66%, but on a three-item corpus that is an ordinary removal.
    assert not gc_would_prune_too_much(2, 3)


def test_nothing_indexed_is_not_an_error() -> None:
    assert not gc_would_prune_too_much(5, 0)


# ── transcript GC ───────────────────────────────────────────────────────


async def test_transcript_gc_scopes_by_model_and_kind() -> None:
    pool = _Pool()
    await delete_stale_transcripts(pool, [("T_A", "ru")], "embed-v1")

    chunks_sql, chunks_args = pool.conn.calls[0]
    assert "kind = 'track_transcript'" in chunks_sql
    assert "embed_model = $3" in chunks_sql
    assert chunks_args == [("T_A", "ru", "embed-v1")]


async def test_transcript_gc_is_atomic() -> None:
    pool = _Pool()
    await delete_stale_transcripts(pool, [("T_A", "ru")], "embed-v1")

    # Both statements ran, inside one transaction (the fake asserts the guard
    # on every executemany), and the transaction was closed.
    assert len(pool.conn.calls) == 2
    assert "DELETE FROM chunks" in pool.conn.calls[0][0]
    assert "DELETE FROM indexed_items" in pool.conn.calls[1][0]
    assert pool.conn.transaction_closed


# ── library GC ──────────────────────────────────────────────────────────


async def test_library_gc_scopes_by_model_and_kinds() -> None:
    pool = _Pool()
    kinds = ("verse", "commentary")
    await delete_stale_library_items(pool, [("BG_1.1", "en")], "embed-v1", kinds)

    chunks_sql, chunks_args = pool.conn.calls[0]
    assert "kind = ANY($4::text[])" in chunks_sql
    assert "embed_model = $3" in chunks_sql
    assert chunks_args == [("BG_1.1", "en", "embed-v1", ["verse", "commentary"])]


async def test_library_gc_is_atomic() -> None:
    pool = _Pool()
    await delete_stale_library_items(pool, [("BG_1.1", "en")], "embed-v1", ("verse",))

    assert len(pool.conn.calls) == 2
    assert "DELETE FROM chunks" in pool.conn.calls[0][0]
    assert "DELETE FROM indexed_items" in pool.conn.calls[1][0]
    assert pool.conn.transaction_closed
