"""Private per-user RAG lane (#1227).

Covers the four load-bearing behaviours:
  1. per-track index round-trip     — `index_one_track` → chunks retrievable
                                       via the `user_track` search lane;
  2. `owned` projection maintenance  — track.ready upserts (with indexing),
                                       library.unlinked deletes,
                                       get_owned_track_ids reflects it;
  3. union retrieval                — `fanout_search_with_boost` merges the
                                       private lane with the corpus lane;
  4. isolation (critical)           — the DEFAULT corpus lane
                                       (eligible_track_ids=None,
                                       kind='track_transcript') NEVER returns a
                                       user_track row, and one user cannot read
                                       another user's tracks.

No Postgres: a small in-memory `FakePg` interprets exactly the handful of SQL
statements these paths issue (kind literal + ACL eligible filter included), so
the isolation assertion exercises the real query construction, not a mock.
"""

from __future__ import annotations

import re
from typing import Any

from lectorium_chat.indexer import run as indexer_run
from lectorium_chat.indexer.orchestrator_adapter import (
    orchestrator_transcript_to_reviewed,
)
from lectorium_chat.infra.broker import track_events_consumer as tec
from lectorium_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from lectorium_chat.infra.repositories.pg_chunk_repository import PgChunkRepository

DIM = 1536
EMBED_MODEL = "fake-model"


# ── Fakes ──────────────────────────────────────────────────────────────


class FakeEmbedder:
    name = EMBED_MODEL
    dim = DIM

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [[float(len(t) % 7) + 0.1] * DIM for t in texts]

    async def embed_query(self, text: str) -> list[float]:
        return [0.1] * DIM

    async def embed_queries(self, texts: list[str]) -> list[list[float]]:
        return [[0.1] * DIM for _ in texts]


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
        if s.startswith("SET LOCAL") or s.startswith("SELECT set_config"):
            return "OK"
        if s.startswith("DELETE FROM chunks"):
            track_id, lang, embed_model, kind = params
            keep = []
            for row in self._db.chunks:
                if (row["track_id"], row["lang"], row["embed_model"], row["kind"]) == (
                    track_id, lang, embed_model, kind,
                ):
                    self._db.embeddings.pop(row["id"], None)
                else:
                    keep.append(row)
            self._db.chunks = keep
            return "DELETE"
        if s.startswith("INSERT INTO indexed_items"):
            kind, item_id, lang, embed_model, etag = params
            self._db.indexed_items[(kind, item_id, lang, embed_model)] = etag
            return "INSERT"
        if s.startswith("INSERT INTO owned"):
            user_id, track_id = params
            self._db.owned.add((user_id, track_id))
            return "INSERT"
        if s.startswith("DELETE FROM owned"):
            user_id, track_id = params
            self._db.owned.discard((user_id, track_id))
            return "DELETE"
        raise AssertionError(f"FakeConn.execute: unhandled SQL: {s[:80]}")

    async def executemany(self, sql: str, args: list[Any]) -> None:
        if "chunk_embeddings_d" in sql and "INSERT" in sql:
            for chunk_id, embedding, kind, lang in args:
                self._db.embeddings[chunk_id] = {
                    "embedding": embedding, "kind": kind, "lang": lang,
                }
            return
        raise AssertionError(f"FakeConn.executemany: unhandled SQL: {sql[:80]}")

    async def fetchrow(self, sql: str, *params: Any) -> Any:
        return None

    async def fetch(self, sql: str, *params: Any) -> list[dict]:
        s = sql.strip()
        if s.startswith("INSERT INTO chunks") and "RETURNING id" in s:
            (track_ids, langs, starts, ends, texts, ref_src,
             embed_models, kinds, author_ids) = params
            out = []
            for i in range(len(track_ids)):
                self._db._id += 1
                cid = self._db._id
                self._db.chunks.append({
                    "id": cid, "track_id": track_ids[i], "lang": langs[i],
                    "start_ms": starts[i], "end_ms": ends[i], "text": texts[i],
                    "reference_source_id": ref_src[i],
                    "embed_model": embed_models[i], "kind": kinds[i],
                    "author_id": author_ids[i],
                })
                out.append({"id": cid})
            return out
        if s.startswith("SELECT track_id FROM owned"):
            user_id = params[0]
            return [{"track_id": t} for (u, t) in sorted(self._db.owned) if u == user_id]
        if "FROM chunks c" in s and "JOIN" in s:
            return self._db._search(s, params)
        raise AssertionError(f"FakeConn.fetch: unhandled SQL: {s[:80]}")


class _Acquire:
    def __init__(self, db: "FakePg") -> None:
        self._db = db

    async def __aenter__(self) -> FakeConn:
        return FakeConn(self._db)

    async def __aexit__(self, *a: Any) -> None:
        return None


class FakePg:
    """Minimal in-memory stand-in for an asyncpg pool."""

    def __init__(self) -> None:
        self.chunks: list[dict] = []
        self.embeddings: dict[int, dict] = {}
        self.indexed_items: dict[tuple, str] = {}
        self.owned: set[tuple[str, str]] = set()
        self._id = 0

    def acquire(self) -> _Acquire:
        return _Acquire(self)

    def _search(self, sql: str, params: tuple) -> list[dict]:
        # Parse the inlined kind literal (defence-in-depth constant the raw
        # query builds) and the ACL eligible-id array param.
        m = re.search(r"e\.kind = '([^']+)'", sql)
        kind = m.group(1) if m else None
        embed_model = params[0]
        # Read the ACL eligible-id array straight from its bound `$N` slot so
        # an EMPTY allowlist (a user who owns nothing) is honoured as "match
        # nothing" — exactly what `= ANY('{}'::text[])` does in Postgres.
        eligible = None
        me = re.search(r"c\.track_id = ANY\(\$(\d+)::text\[\]\)", sql)
        if me:
            eligible = set(params[int(me.group(1)) - 1])
        top_k = params[-1] if isinstance(params[-1], int) else 8
        by_id = {r["id"]: r for r in self.chunks}
        rows = []
        for cid, emb in self.embeddings.items():
            row = by_id.get(cid)
            if row is None:
                continue
            if kind is not None and emb["kind"] != kind:
                continue
            if row["embed_model"] != embed_model:
                continue
            if eligible is not None and row["track_id"] not in eligible:
                continue
            rows.append({
                "track_id": row["track_id"], "lang": row["lang"],
                "start_ms": row["start_ms"], "end_ms": row["end_ms"],
                "text": row["text"],
                "reference_source_id": row["reference_source_id"],
                "score": 0.9,
            })
        return rows[:top_k]


class _Settings:
    embed_dim = DIM
    embed_model = EMBED_MODEL


def _repo(db: FakePg) -> PgChunkRepository:
    return PgChunkRepository(
        pool=db, embed_model=EMBED_MODEL,
        router=EmbeddingTableRouter(dim=DIM), kv_cache=None,
    )


def _orch_transcript(track_id: str) -> dict:
    # Orchestrator shape: flat segments, timestamps in FLOAT seconds.
    return {
        "segments": [
            {"start": 0.0, "end": 4.0, "text": "Krishna speaks of the eternal soul."},
            {"start": 4.0, "end": 9.0, "text": "The soul is never born and never dies."},
            {"start": 9.0, "end": 14.0, "text": "Weapons cannot cut it, fire cannot burn it."},
        ],
    }


# ── 0. adapter ──────────────────────────────────────────────────────────


def test_adapter_seconds_to_ms_and_identity_override() -> None:
    reviewed = orchestrator_transcript_to_reviewed(
        _orch_transcript("t"), track_id="AUTH", lang="en",
    )
    assert reviewed["trackId"] == "AUTH" and reviewed["language"] == "en"
    b0 = reviewed["blocks"][0]
    assert b0["type"] == "sentence" and b0["start"] == 0 and b0["end"] == 4000


def test_adapter_passthrough_reviewed_blocks() -> None:
    payload = {"trackId": "x", "language": "ru",
               "blocks": [{"type": "sentence", "start": 0, "end": 1000, "text": "hi"}]}
    reviewed = orchestrator_transcript_to_reviewed(payload, track_id="T", lang="en")
    assert reviewed["trackId"] == "T" and reviewed["language"] == "en"
    assert reviewed["blocks"] == payload["blocks"]


# ── 1. per-track index round-trip ────────────────────────────────────────


async def test_index_one_track_round_trip(monkeypatch) -> None:
    db = FakePg()
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)
    n = await indexer_run.index_one_track(
        "u-track-1", _orch_transcript("u-track-1"), "en",
        kind="user_track", embedder=FakeEmbedder(), settings=_Settings(),
    )
    assert n >= 1
    # Every persisted chunk + embedding is kind='user_track'.
    assert db.chunks and all(r["kind"] == "user_track" for r in db.chunks)
    assert all(e["kind"] == "user_track" for e in db.embeddings.values())
    assert ("user_track", "u-track-1", "en", EMBED_MODEL) in db.indexed_items

    # Retrievable via the private lane scoped to the owning track id.
    repo = _repo(db)
    hits = await repo.search_by_embedding(
        [0.1] * DIM, eligible_track_ids=["u-track-1"], lang=None,
        top_k=8, kind="user_track",
    )
    assert hits and {h.chunk.track_id for h in hits} == {"u-track-1"}


# ── 2. owned projection maintenance ──────────────────────────────────────


async def test_owned_maintenance_unlink(monkeypatch) -> None:
    db = FakePg()
    monkeypatch.setattr(tec, "get_pool", lambda: db)
    consumer = tec.TrackEventsConsumer.__new__(tec.TrackEventsConsumer)

    # Seed ownership (a prior track.ready), then a removal event revokes it.
    db.owned.add(("userA", "tk"))
    repo = _repo(db)  # get_owned_track_ids reads the projection keyed on sub.
    assert await repo.get_owned_track_ids("userA") == ["tk"]
    assert await repo.get_owned_track_ids("userB") == []

    acked = await consumer.handle(
        {"type": "library.unlinked", "track_id": "tk", "user_id": "userA"}
    )
    assert acked is True and ("userA", "tk") not in db.owned
    assert await repo.get_owned_track_ids("userA") == []


async def test_orchestrator_payload_envelope_indexes(monkeypatch) -> None:
    """HOP4 boundary: the EXACT wire the orchestrator relay emits — a single
    `payload` field carrying `{id,type,user_id,doc_id,track_id,data}` with the
    transcript as a CDN `transcript_key` — must unwrap, set ownership, fetch the
    transcript by key, and index it under user_track. Guards the Python<->Go seam
    the per-service fixtures never exercised."""
    import json

    db = FakePg()
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)
    monkeypatch.setattr(tec, "get_pool", lambda: db)

    # transcript_key resolves to the CDN; stub the fetch to the stored reviewed
    # blob (the same transcript.Reviewed shape the ingest worker writes).
    reviewed = {
        "trackId": "rt-9", "language": "en", "version": 1,
        "blocks": [
            {"type": "sentence", "start": 0, "end": 4000,
             "text": "Krishna speaks of the eternal soul."},
        ],
    }

    async def _fake_fetch(key, settings=None):
        assert key == "public/tracks/rt-9/transcripts/en.json"
        return reviewed

    monkeypatch.setattr("lectorium_chat.indexer.s3.fetch_transcript", _fake_fetch)

    class _FakeRedis:
        def __init__(self) -> None:
            self.s: set[bytes] = set()

        async def sadd(self, key, member):
            if member in self.s:
                return 0
            self.s.add(member)
            return 1

        async def expire(self, *a):
            return True

        async def srem(self, key, member):
            self.s.discard(member)
            return 1

        async def xack(self, *a):
            return 1

    consumer = tec.TrackEventsConsumer.__new__(tec.TrackEventsConsumer)
    consumer._settings = _Settings()
    consumer._embedder = FakeEmbedder()
    consumer._processed_set = "test:processed"
    consumer._stream = "track.events"
    consumer._group = "chat"
    consumer._client = _FakeRedis()

    body = {
        "id": "job-1:ready", "type": "track.ready", "user_id": "userA",
        "doc_id": "rt-9", "track_id": "rt-9",
        "data": {
            "status": "ready", "track_id": "rt-9", "lang": "en",
            "title_raw": "Gita 2.13",
            "audio_key": "public/tracks/rt-9/audio/original.mp3",
            "transcript_key": "public/tracks/rt-9/transcripts/en.json",
            "source_url": "https://y/1",
        },
    }
    raw_fields = {b"payload": json.dumps(body).encode()}
    await consumer._process("1700000000000-0", raw_fields)

    assert ("userA", "rt-9") in db.owned
    assert db.chunks and all(r["kind"] == "user_track" for r in db.chunks)


async def test_reclaim_redelivers_stranded_pending_entry(monkeypatch) -> None:
    """A message left un-ACKed by a prior failed delivery sits in the group PEL;
    the read loop only fetches new ('>') entries, so without reclaim it is lost
    forever. `_reclaim` must XAUTOCLAIM it, re-run the handler (index + own), and
    ACK it — the retry the consumer's contract promises."""
    import json

    db = FakePg()
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)
    monkeypatch.setattr(tec, "get_pool", lambda: db)

    reviewed = {
        "trackId": "rt-strand", "language": "en", "version": 1,
        "blocks": [{"type": "sentence", "start": 0, "end": 3000,
                    "text": "The soul is never born and never dies."}],
    }

    async def _fake_fetch(key, settings=None):
        return reviewed

    monkeypatch.setattr("lectorium_chat.indexer.s3.fetch_transcript", _fake_fetch)

    body = {
        "id": "job-strand:ready", "type": "track.ready", "user_id": "userS",
        "doc_id": "rt-strand", "track_id": "rt-strand",
        "data": {"status": "ready", "track_id": "rt-strand", "lang": "en",
                 "transcript_key": "public/tracks/rt-strand/transcripts/en.json"},
    }

    class _FakeRedis:
        def __init__(self) -> None:
            self.s: set[bytes] = set()
            self.acked: list = []
            self._claim_calls = 0

        async def xautoclaim(self, stream, group, consumer, min_idle, *,
                             start_id="0-0", count=16):
            # First scan surfaces the one stranded entry; subsequent scans drain.
            self._claim_calls += 1
            if self._claim_calls == 1:
                msg = ("1700000000000-0", {b"payload": json.dumps(body).encode()})
                return (b"0-0", [msg], [])
            return (b"0-0", [], [])

        async def sadd(self, key, member):
            if member in self.s:
                return 0
            self.s.add(member)
            return 1

        async def expire(self, *a):
            return True

        async def srem(self, key, member):
            self.s.discard(member)
            return 1

        async def xack(self, stream, group, msg_id):
            self.acked.append(msg_id)
            return 1

    consumer = tec.TrackEventsConsumer.__new__(tec.TrackEventsConsumer)
    consumer._settings = _Settings()
    consumer._embedder = FakeEmbedder()
    consumer._processed_set = "test:processed"
    consumer._stream = "track.events"
    consumer._group = "chat"
    consumer._consumer = "chat-1"
    consumer._client = _FakeRedis()

    await consumer._reclaim()

    assert ("userS", "rt-strand") in db.owned
    assert db.chunks and all(r["kind"] == "user_track" for r in db.chunks)
    assert consumer._client.acked == ["1700000000000-0"]


async def test_track_ready_indexes_and_owns(monkeypatch) -> None:
    import json

    db = FakePg()
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)
    monkeypatch.setattr(tec, "get_pool", lambda: db)

    consumer = tec.TrackEventsConsumer.__new__(tec.TrackEventsConsumer)
    consumer._settings = _Settings()
    consumer._embedder = FakeEmbedder()
    consumer._processed_set = "test:processed"

    class _FakeRedis:
        def __init__(self) -> None:
            self.s: set[bytes] = set()

        async def sadd(self, key, member):
            if member in self.s:
                return 0
            self.s.add(member)
            return 1

        async def expire(self, *a):
            return True

        async def srem(self, key, member):
            self.s.discard(member)
            return 1

    consumer._client = _FakeRedis()

    fields = {
        "type": "track.ready", "track_id": "rt-1", "user_id": "userA",
        "lang": "en", "transcript": json.dumps(_orch_transcript("rt-1")),
    }
    assert await consumer.handle(fields) is True
    assert ("userA", "rt-1") in db.owned
    assert db.chunks and all(r["kind"] == "user_track" for r in db.chunks)

    # Idempotent by track_id: redelivery does not re-index (chunk count stable).
    before = len(db.chunks)
    assert await consumer.handle(fields) is True
    assert len(db.chunks) == before


# ── 3. union retrieval (fanout merges private + corpus) ──────────────────


class _StubCatalog:
    async def filter_track_ids(self, **_: Any) -> list[str] | None:
        return None  # no metadata filter → whole corpus eligible


class _UnionRepo:
    """Corpus lane returns a corpus track; user_track lane returns a private
    track only when its ACL eligible set is supplied."""

    def __init__(self) -> None:
        self.kinds_queried: list[str] = []

    async def search_by_embedding(
        self, _vec, *, eligible_track_ids=None, excluded_track_ids=None,
        lang=None, top_k=8, kind="track_transcript",
    ):
        from lectorium_chat.domain.entities import Chunk, ScoredChunk
        self.kinds_queried.append(kind)
        if kind == "track_transcript":
            c = Chunk(track_id="corpus-1", lang="en", start_ms=0, end_ms=1000,
                      text="corpus text", reference_source_id=None)
            return [ScoredChunk(chunk=c, score=0.8)]
        if kind == "user_track" and eligible_track_ids:
            c = Chunk(track_id="user-1", lang="en", start_ms=0, end_ms=1000,
                      text="private text", reference_source_id=None)
            return [ScoredChunk(chunk=c, score=0.85)]
        return []

    async def search_library_by_embedding(self, *a, **k):
        return []

    async def search_chunks_lexical(self, *a, **k):
        return []

    async def get_chunks_by_addr_label(self, *a, **k):
        return []


async def _run_fanout(repo, owned):
    from lectorium_chat.agent.turn_aliases import TurnAliasMap
    from lectorium_chat.research.corpus_fanout import fanout_search_with_boost
    return await fanout_search_with_boost(
        [(0, "what is the soul")],
        embedder=FakeEmbedder(), chunk_repo=repo, catalog_repo=_StubCatalog(),
        alias_map=TurnAliasMap(), lang="en", owned_track_ids=owned,
    )


async def test_union_merges_private_with_corpus() -> None:
    repo = _UnionRepo()
    result = await _run_fanout(repo, owned=["user-1"])
    texts = {e["text"] for e in result.chunks}
    assert "corpus text" in texts and "private text" in texts
    assert "user_track" in repo.kinds_queried


async def test_union_no_owned_is_corpus_only() -> None:
    repo = _UnionRepo()
    result = await _run_fanout(repo, owned=None)
    texts = {e["text"] for e in result.chunks}
    assert "corpus text" in texts and "private text" not in texts
    # With no ACL the private lane is skipped entirely (no wasted ANN call).
    assert "user_track" not in repo.kinds_queried


# ── 4. isolation (critical) ──────────────────────────────────────────────


async def _seed_both_lanes(db: FakePg, monkeypatch) -> None:
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)
    # A corpus track and two users' private tracks.
    await indexer_run.index_one_track(
        "corpus-A", _orch_transcript("corpus-A"), "en",
        kind="track_transcript", embedder=FakeEmbedder(), settings=_Settings(),
    )
    await indexer_run.index_one_track(
        "userA-track", _orch_transcript("userA-track"), "en",
        kind="user_track", embedder=FakeEmbedder(), settings=_Settings(),
    )
    await indexer_run.index_one_track(
        "userB-track", _orch_transcript("userB-track"), "en",
        kind="user_track", embedder=FakeEmbedder(), settings=_Settings(),
    )


async def test_default_corpus_lane_never_returns_user_tracks(monkeypatch) -> None:
    db = FakePg()
    await _seed_both_lanes(db, monkeypatch)
    repo = _repo(db)
    # DEFAULT lane: eligible=None, kind defaults to 'track_transcript'.
    hits = await repo.search_by_embedding([0.1] * DIM, lang=None, top_k=50)
    ids = {h.chunk.track_id for h in hits}
    assert ids == {"corpus-A"}
    assert "userA-track" not in ids and "userB-track" not in ids


async def test_user_track_lane_is_acl_scoped_no_cross_user(monkeypatch) -> None:
    db = FakePg()
    await _seed_both_lanes(db, monkeypatch)
    repo = _repo(db)

    # User A sees only their own track, even though B's is indexed.
    a_hits = await repo.search_by_embedding(
        [0.1] * DIM, eligible_track_ids=["userA-track"], lang=None,
        top_k=50, kind="user_track",
    )
    assert {h.chunk.track_id for h in a_hits} == {"userA-track"}

    # Empty ACL → nothing (a user who owns nothing).
    none_hits = await repo.search_by_embedding(
        [0.1] * DIM, eligible_track_ids=[], lang=None, top_k=50, kind="user_track",
    )
    assert none_hits == []

    # The user_track lane never leaks the public corpus track either.
    assert all(h.chunk.track_id != "corpus-A" for h in a_hits)


async def test_the_speaker_is_stamped_on_the_chunks_at_index_time(monkeypatch) -> None:
    """What makes a lecturer filter reach a private upload: the ingest's speaker
    name is resolved ONCE here and written to `chunks.author_id`, the same column
    the public lane filters by. No side table, no per-turn name matching."""
    import json

    db = FakePg()
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)
    monkeypatch.setattr(tec, "get_pool", lambda: db)

    reviewed = {
        "trackId": "rt-a", "language": "ru", "version": 1,
        "blocks": [{"type": "sentence", "start": 0, "end": 3000,
                    "text": "Смирение — основа преданности."}],
    }

    async def _fake_fetch(key, settings=None):
        return reviewed

    monkeypatch.setattr("lectorium_chat.indexer.s3.fetch_transcript", _fake_fetch)

    class _Catalog:
        def __init__(self) -> None:
            self.asked: list[str] = []

        async def resolve(self, kind, text, *, lang, limit):
            self.asked.append(text)
            from types import SimpleNamespace
            # One row PER LOCALE, like the real dictionary — a single Latin row
            # cannot match a name typed in Cyrillic, and that is what makes this
            # resolve work at all.
            return [
                SimpleNamespace(
                    id="author_prabhupada",
                    full_name="A. C. Bhaktivedanta Swami Prabhupada",
                ),
                SimpleNamespace(
                    id="author_prabhupada",
                    full_name="А. Ч. Бхактиведанта Свами Прабхупада",
                ),
            ]

    class _Redis:
        def __init__(self) -> None:
            self.s: set[bytes] = set()

        async def sadd(self, key, member):
            if member in self.s:
                return 0
            self.s.add(member)
            return 1

        async def expire(self, *a):
            return True

        async def srem(self, key, member):
            self.s.discard(member)
            return 1

        async def xack(self, *a):
            return 1

    catalog = _Catalog()
    consumer = tec.TrackEventsConsumer.__new__(tec.TrackEventsConsumer)
    consumer._settings = _Settings()
    consumer._embedder = FakeEmbedder()
    consumer._processed_set = "test:processed"
    consumer._stream = "track.events"
    consumer._group = "chat"
    consumer._client = _Redis()
    consumer._catalog_repo = catalog

    body = {
        "id": "job-a:ready", "type": "track.ready", "user_id": "userA",
        "doc_id": "rt-a", "track_id": "rt-a",
        "data": {
            "status": "ready", "track_id": "rt-a", "lang": "ru",
            # Typed in Cyrillic on the upload; the catalog row is Latin.
            "author_raw": "Прабхупада", "title_raw": "О смирении",
            "transcript_key": "public/tracks/rt-a/transcripts/ru.json",
        },
    }
    await consumer._process("1700000000002-0", {b"payload": json.dumps(body).encode()})

    assert catalog.asked == ["Прабхупада"]
    assert db.chunks and all(
        r["author_id"] == "author_prabhupada" for r in db.chunks
    )


async def test_an_unknown_speaker_leaves_the_chunks_unattributed(monkeypatch) -> None:
    # Nothing to resolve, or nobody in the catalog by that name: the rows carry
    # no author, and a lecturer filter passes them over rather than guessing.
    db = FakePg()
    monkeypatch.setattr(indexer_run, "get_pool", lambda: db)

    reviewed = {
        "trackId": "rt-b", "language": "ru", "version": 1,
        "blocks": [{"type": "sentence", "start": 0, "end": 2000, "text": "Текст."}],
    }
    n = await indexer_run.index_one_track(
        "rt-b", reviewed, "ru", kind="user_track",
        embedder=FakeEmbedder(), settings=_Settings(), author_id=None,
    )
    assert n == 1
    assert all(r["author_id"] is None for r in db.chunks)
