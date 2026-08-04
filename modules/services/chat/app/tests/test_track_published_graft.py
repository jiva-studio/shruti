"""Corpus-promotion graft (#1236).

`track.published` (emitted by publish-service when an approved user track is
promoted) grafts that track's already-indexed `user_track` chunks onto the
public `track_transcript` lane and drops its `owned` ACL rows — no re-embedding.

Covers:
  1. `_graft_promoted_track` relabels chunks + embeddings and drops owned;
  2. idempotency — a second graft matches nothing (returns 0);
  3. the `TrackPublishedConsumer.handle` parses both the JSON `payload`
     envelope and flat stream fields, and drops an id-less message.

No Postgres: a tiny in-memory `FakePg` interprets exactly the SQL the graft
issues.
"""

from __future__ import annotations

import json
from typing import Any

from shruti_chat.indexer import run as indexer_run
from shruti_chat.infra.broker import track_published_consumer as tpc

DIM = 1536


# ── Fakes ──────────────────────────────────────────────────────────────


class _Txn:
    async def __aenter__(self) -> "_Txn":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None


class FakeConn:
    def __init__(self, db: "FakePg") -> None:
        self._db = db

    def transaction(self) -> _Txn:
        return _Txn()

    async def execute(self, sql: str, *params: Any) -> str:
        s = sql.strip()
        if s.startswith("UPDATE") and "chunk_embeddings_d" in s:
            (track_id,) = params
            ids = {
                r["id"]
                for r in self._db.chunks
                if r["track_id"] == track_id and r["kind"] == "user_track"
            }
            for cid in ids:
                if cid in self._db.embeddings:
                    self._db.embeddings[cid]["kind"] = "track_transcript"
            return f"UPDATE {len(ids)}"
        if s.startswith("UPDATE chunks SET kind"):
            (track_id,) = params
            n = 0
            for r in self._db.chunks:
                if r["track_id"] == track_id and r["kind"] == "user_track":
                    r["kind"] = "track_transcript"
                    n += 1
            return f"UPDATE {n}"
        if s.startswith("DELETE FROM chunk_meta"):
            (track_id,) = params
            before = len(self._db.meta)
            for key in [k for k in self._db.meta if k[1] == track_id]:
                self._db.meta.pop(key)
            return f"DELETE {before - len(self._db.meta)}"
        raise AssertionError(f"FakeConn.execute: unhandled SQL: {s[:80]}")


class _Acquire:
    def __init__(self, db: "FakePg") -> None:
        self._db = db

    async def __aenter__(self) -> FakeConn:
        return FakeConn(self._db)

    async def __aexit__(self, *a: Any) -> None:
        return None


class FakePg:
    def __init__(self) -> None:
        self.chunks: list[dict] = []
        self.embeddings: dict[int, dict] = {}
        # (owner_id, track_id) -> {author_id, author_raw}: who may read this
        # group of chunks and who is speaking on it.
        self.meta: dict[tuple[str, str], dict[str, str | None]] = {}

    def acquire(self) -> _Acquire:
        return _Acquire(self)


class _Settings:
    embed_dim = DIM
    embed_model = "fake-model"


def _seed(db: FakePg, track_id: str) -> None:
    for cid in (1, 2):
        db.chunks.append(
            {"id": cid, "track_id": track_id, "kind": "user_track"}
        )
        db.embeddings[cid] = {"kind": "user_track"}
    db.meta.setdefault(("userA", track_id))
    db.meta.setdefault(("userB", track_id))
    # An unrelated user_track that must be left untouched.
    db.chunks.append({"id": 9, "track_id": "other", "kind": "user_track"})
    db.embeddings[9] = {"kind": "user_track"}


# ── 1. graft relabels + drops owned ──────────────────────────────────────


async def test_graft_relabels_and_drops_the_private_records(monkeypatch) -> None:
    db = FakePg()
    _seed(db, "trk-1")
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)

    n = await indexer_run._graft_promoted_track("trk-1", settings=_Settings())
    assert n == 2
    # The promoted track's rows are now public.
    assert all(
        r["kind"] == "track_transcript"
        for r in db.chunks
        if r["track_id"] == "trk-1"
    )
    assert all(
        db.embeddings[r["id"]]["kind"] == "track_transcript"
        for r in db.chunks
        if r["track_id"] == "trk-1"
    )
    # ACL rows for the track are gone.
    assert not any(t == "trk-1" for (_u, t) in db.meta)
    # The unrelated user_track is untouched.
    assert db.chunks[-1]["kind"] == "user_track"
    assert db.embeddings[9]["kind"] == "user_track"


# ── 2. idempotency ───────────────────────────────────────────────────────


async def test_graft_is_idempotent(monkeypatch) -> None:
    db = FakePg()
    _seed(db, "trk-1")
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)
    assert await indexer_run._graft_promoted_track("trk-1", settings=_Settings()) == 2
    # Second graft matches nothing — a cheap no-op.
    assert await indexer_run._graft_promoted_track("trk-1", settings=_Settings()) == 0


# ── 3. consumer handle parses payload + flat fields ──────────────────────


def _consumer() -> tpc.TrackPublishedConsumer:
    c = tpc.TrackPublishedConsumer.__new__(tpc.TrackPublishedConsumer)
    c._settings = _Settings()
    return c


async def test_handle_payload_envelope(monkeypatch) -> None:
    db = FakePg()
    _seed(db, "trk-1")
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)
    c = _consumer()
    fields = {
        "payload": json.dumps(
            {"type": "track.published", "track_id": "trk-1", "owner_id": "userA"}
        )
    }
    assert await c.handle(fields) is True
    assert all(
        r["kind"] == "track_transcript"
        for r in db.chunks
        if r["track_id"] == "trk-1"
    )


async def test_handle_flat_fields(monkeypatch) -> None:
    db = FakePg()
    _seed(db, "trk-1")
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)
    c = _consumer()
    assert await c.handle({"track_id": "trk-1"}) is True
    assert not any(t == "trk-1" for (_u, t) in db.meta)


async def test_handle_missing_track_id_is_acked(monkeypatch) -> None:
    calls = {"n": 0}

    async def _spy(track_id: str, *, settings=None) -> int:
        calls["n"] += 1
        return 0

    monkeypatch.setattr(tpc, "_graft_promoted_track", _spy)
    c = _consumer()
    assert await c.handle({}) is True  # dropped, not retried
    assert calls["n"] == 0
