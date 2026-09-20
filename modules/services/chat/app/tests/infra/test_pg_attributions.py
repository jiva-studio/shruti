"""The attribution SQL, now that it lives behind `PgChunkRepository`.

`research/attribution_lookup.py` used to hold these three statements and its
unit tests drove them through a fake connection that dispatched on the SQL
text. Moving them into the adapter left that coverage behind: the research
tests now script a fake repository, so nothing exercises the statements
themselves any more.

These assertions therefore sit at the same level the old fake did — on the
SQL emitted and the parameters bound — because that is where the behaviour
lives: which stage drops the language predicate, when the text lookup falls
back, and how a missing note picks a substitute language. The row-decoding
assertions cover the other half: `refs` arrives as jsonb text and has to come
back as plain maps.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest

from shruti_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from shruti_chat.infra.repositories.pg_chunk_repository import PgChunkRepository


DIM = 256
EMBED_MODEL = "test-embed"
EMB_TABLE = f"attribution_emb_d{DIM}"


# ---- fake asyncpg-shaped pool ---------------------------------------------


class _Conn:
    def __init__(self, pool: "_ScriptedPool") -> None:
        self._pool = pool

    async def fetch(self, sql: str, *params: Any) -> list[dict]:
        return self._pool._answer(sql, params)

    async def fetchrow(self, sql: str, *params: Any) -> dict | None:
        rows = self._pool._answer(sql, params)
        return rows[0] if rows else None


class _Acquire:
    def __init__(self, pool: "_ScriptedPool") -> None:
        self._pool = pool

    async def __aenter__(self) -> _Conn:
        return _Conn(self._pool)

    async def __aexit__(self, *a: Any) -> None:
        return None


class _ScriptedPool:
    """Records every statement and answers via `responder(sql, params)`."""

    def __init__(
        self, responder: Callable[[str, tuple], list[dict]] | None = None
    ) -> None:
        self.queries: list[tuple[str, tuple]] = []
        self._responder = responder or (lambda sql, params: [])

    def _answer(self, sql: str, params: tuple) -> list[dict]:
        self.queries.append((_flat(sql), params))
        return self._responder(sql, params)

    def acquire(self) -> _Acquire:
        return _Acquire(self)


def _flat(sql: str) -> str:
    return " ".join(sql.split())


def _repo(pool: _ScriptedPool) -> PgChunkRepository:
    return PgChunkRepository(
        pool=pool,
        embed_model=EMBED_MODEL,
        router=EmbeddingTableRouter(dim=DIM),
        kv_cache=None,
    )


def _hit(aid: str, score: float, refs: list | None = None) -> dict:
    return {
        "id": aid,
        "refs_json": json.dumps(
            refs if refs is not None else [{"ref_kind": "verse", "target_id": "verse_x"}]
        ),
        "score": score,
    }


# ---- find_attributions: statement shape -----------------------------------


async def test_native_stage_filters_by_language() -> None:
    pool = _ScriptedPool()
    await _repo(pool).find_attributions([0.1] * DIM, kind="pinned", lang="ru")

    (sql, params), = pool.queries
    assert f"FROM {EMB_TABLE} e" in sql
    assert "WHERE e.language = $2 AND e.embed_model = $3 AND a.kind = $4" in sql
    assert params == ([0.1] * DIM, "ru", EMBED_MODEL, "pinned")


async def test_cross_lingual_stage_drops_the_language_predicate() -> None:
    """`lang=None` is the cross-lingual stage: same query, no language filter.

    If the predicate survived with a NULL bound to it the stage would match
    nothing and every cross-lingual hit in `attribution_lookup` would vanish.
    """
    pool = _ScriptedPool()
    await _repo(pool).find_attributions([0.1] * DIM, kind="topic", lang=None)

    (sql, params), = pool.queries
    assert "e.language" not in sql
    assert "WHERE e.embed_model = $2 AND a.kind = $3" in sql
    assert params == ([0.1] * DIM, EMBED_MODEL, "topic")


async def test_variants_collapse_to_the_best_scoring_one() -> None:
    """One attribution with N curated phrasings must rank once, at its best.

    Without the `MAX(...) ... GROUP BY` it would occupy N of the 10 slots and
    crowd out other attributions.
    """
    pool = _ScriptedPool()
    await _repo(pool).find_attributions([0.1] * DIM, kind="pinned", lang="ru")

    sql, _ = pool.queries[0]
    assert "MAX(1 - (e.embedding <=> $1::vector)) AS score" in sql
    assert "GROUP BY a.id, a.refs" in sql
    assert "ORDER BY score DESC" in sql
    assert "LIMIT 10" in sql


async def test_lookup_targets_the_table_for_the_configured_dim() -> None:
    pool = _ScriptedPool()
    repo = PgChunkRepository(
        pool=pool,
        embed_model=EMBED_MODEL,
        router=EmbeddingTableRouter(dim=1536),
        kv_cache=None,
    )
    await repo.find_attributions([0.1] * 1536, kind="pinned", lang="ru")

    assert "FROM attribution_emb_d1536 e" in pool.queries[0][0]


# ---- find_attributions: row decoding --------------------------------------


async def test_rows_decode_into_candidates() -> None:
    refs = [
        {"ref_kind": "verse", "target_id": "verse_a"},
        {"ref_kind": "chapter", "target_id": "chapter_b"},
    ]
    pool = _ScriptedPool(lambda sql, params: [_hit("a1", 0.91, refs), _hit("a2", 0.4)])
    out = await _repo(pool).find_attributions([0.1] * DIM, kind="pinned", lang="ru")

    assert [c.attribution_id for c in out] == ["a1", "a2"]
    assert out[0].refs == refs
    assert out[0].score == pytest.approx(0.91)


async def test_non_mapping_refs_are_dropped() -> None:
    """`refs` is a jsonb array the seeding tooling writes; a scalar in it must
    not reach the research layer, which indexes every entry as a map."""
    pool = _ScriptedPool(
        lambda sql, params: [
            _hit("a1", 0.9, ["verse_x", {"ref_kind": "verse", "target_id": "verse_y"}])
        ]
    )
    out = await _repo(pool).find_attributions([0.1] * DIM, kind="pinned", lang="ru")

    assert out[0].refs == [{"ref_kind": "verse", "target_id": "verse_y"}]


@pytest.mark.parametrize("refs_json", [None, "", "[]"])
async def test_absent_refs_decode_to_an_empty_list(refs_json: str | None) -> None:
    pool = _ScriptedPool(
        lambda sql, params: [{"id": "a1", "refs_json": refs_json, "score": 0.9}]
    )
    out = await _repo(pool).find_attributions([0.1] * DIM, kind="pinned", lang="ru")

    assert out[0].refs == []


# ---- attribution_texts ----------------------------------------------------


async def test_texts_prefer_the_requested_language() -> None:
    pool = _ScriptedPool(lambda sql, params: [{"text": "ru phrasing"}])
    out = await _repo(pool).attribution_texts("a1", lang="ru")

    assert out == ["ru phrasing"]
    (sql, params), = pool.queries
    assert f"SELECT DISTINCT text FROM {EMB_TABLE}" in sql
    assert "WHERE attribution_id = $1 AND embed_model = $2 AND language = $3" in sql
    assert params == ("a1", EMBED_MODEL, "ru")


async def test_texts_fall_back_when_the_language_has_none() -> None:
    """A curated attribution seeded only in English still has to yield its
    phrasings to a Russian border-gate rerank; otherwise the gate reranks an
    empty document list and the match is silently lost."""
    seen: list[str] = []

    def responder(sql: str, params: tuple) -> list[dict]:
        seen.append(_flat(sql))
        if "language" in sql:
            return []
        return [{"text": "en phrasing"}]

    pool = _ScriptedPool(responder)
    out = await _repo(pool).attribution_texts("a1", lang="ru")

    assert out == ["en phrasing"]
    assert len(pool.queries) == 2
    assert "language" not in pool.queries[1][0]
    assert pool.queries[1][1] == ("a1", EMBED_MODEL)


async def test_texts_without_a_language_ask_once() -> None:
    pool = _ScriptedPool(lambda sql, params: [{"text": "any phrasing"}])
    out = await _repo(pool).attribution_texts("a1", lang=None)

    assert out == ["any phrasing"]
    (sql, params), = pool.queries
    assert "language" not in sql
    assert params == ("a1", EMBED_MODEL)


async def test_texts_drop_empty_rows() -> None:
    pool = _ScriptedPool(
        lambda sql, params: [{"text": "kept"}, {"text": ""}, {"text": None}]
    )
    assert await _repo(pool).attribution_texts("a1", lang=None) == ["kept"]


# ---- fetch_attribution_note -----------------------------------------------


async def test_note_returns_the_requested_language() -> None:
    pool = _ScriptedPool(lambda sql, params: [{"note": "заметка"}])
    assert await _repo(pool).fetch_attribution_note("a1", lang="ru") == "заметка"

    (sql, params), = pool.queries
    assert "FROM attribution_notes WHERE attribution_id = $1 AND language = $2" in sql
    assert params == ("a1", "ru")


async def test_note_falls_back_preferring_english() -> None:
    def responder(sql: str, params: tuple) -> list[dict]:
        if "language = $2" in sql:
            return []
        return [{"note": "english note"}]

    pool = _ScriptedPool(responder)
    assert await _repo(pool).fetch_attribution_note("a1", lang="ru") == "english note"

    assert len(pool.queries) == 2
    fallback, params = pool.queries[1]
    assert "ORDER BY (language = 'en') DESC, language LIMIT 1" in fallback
    assert params == ("a1",)


async def test_note_absent_everywhere_is_none() -> None:
    pool = _ScriptedPool()
    assert await _repo(pool).fetch_attribution_note("a1", lang="ru") is None
    assert len(pool.queries) == 2
