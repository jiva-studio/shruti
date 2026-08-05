"""`search_by_embedding` must rank by similarity, not by track_id.

The de-duplicated branch (recommend / `chunks_find_similar`, i.e. any call
with `excluded_track_ids`) used to write `DISTINCT ON (c.track_id) … ORDER BY
c.track_id, distance LIMIT k` at a single level. Postgres has to sort by the
`DISTINCT ON` key first, so `LIMIT` kept the k lexicographically-smallest
track_ids instead of the k nearest — and the track_id ordering also stopped
the HNSW index from driving the scan.

These assertions are on the SQL the repository emits, because the defect is
in the statement's shape: no fake can reproduce Postgres' `DISTINCT ON`
ordering rule without re-implementing it.
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from lectorium_chat.infra.repositories.pg_chunk_repository import (
    _DEDUP_CANDIDATE_FACTOR,
    PgChunkRepository,
)


DIM = 256
EMBED_MODEL = "test-embed"


class _Txn:
    async def __aenter__(self) -> "_Txn":
        return self

    async def __aexit__(self, *a: Any) -> None:
        return None


class _Conn:
    def __init__(self, sink: "_CapturingPool") -> None:
        self._sink = sink

    def transaction(self) -> _Txn:
        return _Txn()

    async def execute(self, sql: str, *params: Any) -> str:
        return "OK"

    async def fetch(self, sql: str, *params: Any) -> list[dict]:
        self._sink.sql = sql
        self._sink.params = params
        return self._sink.rows


class _Acquire:
    def __init__(self, sink: "_CapturingPool") -> None:
        self._sink = sink

    async def __aenter__(self) -> _Conn:
        return _Conn(self._sink)

    async def __aexit__(self, *a: Any) -> None:
        return None


class _CapturingPool:
    def __init__(self, rows: list[dict] | None = None) -> None:
        self.sql: str = ""
        self.params: tuple = ()
        self.rows: list[dict] = rows or []

    def acquire(self) -> _Acquire:
        return _Acquire(self)


def _repo(pool: _CapturingPool) -> PgChunkRepository:
    return PgChunkRepository(
        pool=pool, embed_model=EMBED_MODEL,
        router=EmbeddingTableRouter(dim=DIM), kv_cache=None,
    )


def _flat(sql: str) -> str:
    return " ".join(sql.split())


async def test_dedup_branch_ranks_by_distance_outside_the_collapse() -> None:
    pool = _CapturingPool()
    await _repo(pool).search_by_embedding(
        [0.1] * DIM, excluded_track_ids=["T_SRC"], lang=None, top_k=6,
    )
    sql = _flat(pool.sql)

    # $1 embed_model, $2 excluded ids, $3 embedding, $4 top_k, $5 candidates.
    assert sql.endswith(") t ORDER BY t.dist LIMIT $4"), sql
    # The collapse is nested, so its track_id ordering cannot reach the cut.
    assert sql.index("DISTINCT ON") < sql.index("ORDER BY t.dist")
    assert "ORDER BY cand.track_id, cand.dist" in sql


async def test_dedup_branch_bounds_the_candidate_scan() -> None:
    pool = _CapturingPool()
    await _repo(pool).search_by_embedding(
        [0.1] * DIM, excluded_track_ids=["T_SRC"], lang=None, top_k=6,
    )
    sql = _flat(pool.sql)

    # The inner scan is distance-ordered (so HNSW drives it) and bounded.
    assert "ORDER BY e.embedding <=> $3::vector LIMIT $5" in sql
    assert pool.params[-1] == 6 * _DEDUP_CANDIDATE_FACTOR


async def test_plain_branch_stays_a_single_level_top_k() -> None:
    pool = _CapturingPool()
    await _repo(pool).search_by_embedding(
        [0.1] * DIM, lang=None, top_k=8,
    )
    sql = _flat(pool.sql)

    assert "DISTINCT ON" not in sql
    assert sql.endswith("ORDER BY e.embedding <=> $2::vector LIMIT $3"), sql


async def test_rows_map_to_scored_chunks_in_returned_order() -> None:
    rows = [
        {"track_id": "T_B", "lang": "ru", "start_ms": 0, "end_ms": 1000,
         "text": "closer", "reference_source_id": None, "score": 0.91},
        {"track_id": "T_A", "lang": "ru", "start_ms": 0, "end_ms": 1000,
         "text": "farther", "reference_source_id": None, "score": 0.42},
    ]
    pool = _CapturingPool(rows)
    scored = await _repo(pool).search_by_embedding(
        [0.1] * DIM, excluded_track_ids=["T_SRC"], lang=None, top_k=6,
    )

    assert [s.chunk.track_id for s in scored] == ["T_B", "T_A"]
    assert [s.score for s in scored] == [0.91, 0.42]
