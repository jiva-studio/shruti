"""Deleting an account has to take its uploads with it.

`user.deleted` already purged the person's Langfuse traces and their synced
profile. The chat side was nobody's job, so the transcripts of the lectures
they had added stayed indexed: on production, three deleted accounts still had
three `chunk_meta` rows and **27 chunks** of their uploads in the corpus.

The rule that makes this safe to run is the shape of `chunk_meta`: one row per
owner per track. Two people who added the same recording have two rows, so the
departing owner's row goes and the chunks stay for the other; the chunks go
only when the last owner is gone. Embeddings follow by cascade (0030).
"""

from __future__ import annotations

from typing import Any

import pytest

from lectorium_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from lectorium_chat.infra.repositories.pg_chunk_repository import PgChunkRepository


class _Conn:
    """A transaction-scoped fake: records the statements and answers them from
    a tiny in-memory `chunk_meta`."""

    def __init__(self, meta: list[tuple[str, str]]) -> None:
        self.meta = list(meta)          # (owner_id, track_id)
        self.sql: list[str] = []
        self.deleted_tracks: list[str] = []

    def transaction(self):
        conn = self

        class _Tx:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *_exc):
                return False

        return _Tx()

    async def fetch(self, sql: str, *args: Any):
        self.sql.append(sql)
        owner = args[0]
        gone = [(o, t) for o, t in self.meta if o == owner]
        self.meta = [(o, t) for o, t in self.meta if o != owner]
        return [{"track_id": t} for _, t in gone]

    async def fetchval(self, sql: str, *args: Any):
        self.sql.append(sql)
        # The real statement deletes only tracks with no owner left; mirror the
        # CONDITION here rather than the SQL, so the test cannot pass by
        # agreeing with a wrong query.
        orphaned = [t for t in args[0] if all(mt != t for _, mt in self.meta)]
        self.deleted_tracks = orphaned
        return len(orphaned)


class _Pool:
    def __init__(self, conn: _Conn) -> None:
        self._conn = conn

    def acquire(self):
        conn = self._conn

        class _Acq:
            async def __aenter__(self):
                return conn

            async def __aexit__(self, *_exc):
                return False

        return _Acq()


def _repo(conn: _Conn) -> PgChunkRepository:
    return PgChunkRepository(
        pool=_Pool(conn), embed_model="m", router=EmbeddingTableRouter(1536),
    )


async def test_the_owners_rows_and_their_chunks_go() -> None:
    conn = _Conn([("gone", "t1"), ("gone", "t2")])
    got = await _repo(conn).purge_owner("gone")

    assert got == {"meta_rows": 2, "chunks": 2}
    assert sorted(conn.deleted_tracks) == ["t1", "t2"]
    assert conn.meta == []


async def test_a_recording_someone_else_also_added_survives() -> None:
    """Two people, one upload, two rows — that is what the owner-per-row shape
    was for. Deleting one account must not take the other's copy."""
    conn = _Conn([("gone", "shared"), ("stays", "shared")])
    got = await _repo(conn).purge_owner("gone")

    assert got["meta_rows"] == 1
    assert got["chunks"] == 0, "the other owner still has it"
    assert conn.meta == [("stays", "shared")]


async def test_purging_an_account_with_nothing_touches_nothing() -> None:
    conn = _Conn([("someone", "t1")])
    got = await _repo(conn).purge_owner("never-added-anything")

    assert got == {"meta_rows": 0, "chunks": 0}
    assert conn.meta == [("someone", "t1")]


async def test_a_second_purge_is_a_no_op() -> None:
    """The outbox retries; a re-run must return zeroes rather than fail."""
    repo = _repo(_Conn([("gone", "t1")]))
    await repo.purge_owner("gone")
    assert await repo.purge_owner("gone") == {"meta_rows": 0, "chunks": 0}


@pytest.mark.parametrize("user_id", ["", "   "])
async def test_an_empty_user_deletes_nothing(user_id: str) -> None:
    conn = _Conn([("gone", "t1")])
    got = await _repo(conn).purge_owner(user_id.strip())

    assert got == {"meta_rows": 0, "chunks": 0}
    assert conn.sql == [], "no statement may run without a user"


def test_the_statement_only_removes_unowned_private_chunks() -> None:
    """Asserted on the SQL because two conditions must never drift apart: the
    delete is limited to `user_track` chunks, and only to tracks no remaining
    `chunk_meta` row claims."""
    import inspect

    sql = inspect.getsource(PgChunkRepository.purge_owner)
    assert "kind = 'user_track'" in sql
    assert "NOT EXISTS" in sql and "FROM chunk_meta cm" in sql
