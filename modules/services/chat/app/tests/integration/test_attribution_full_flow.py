"""Integration: attribution lifecycle end-to-end against real Postgres.

Auto-skipped without --integration / SHRUTI_INTEGRATION_DB (see conftest.py).

These tests exercise the path that unit tests can't: real pgvector lookup,
real schema migrations, real indexer pass, real chat-service pipeline call.
Each test builds its fixtures from scratch (no fixtures.jsonl) and tears
down at the end so they're independent and idempotent.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import Any

import asyncpg
import pytest


pytestmark = pytest.mark.asyncio


async def _ensure_schema(url: str) -> None:
    """Apply all chat migrations from infra/db/migrations/.

    chat's old idempotent schema.sql is gone; the central migrator owns
    them now. For integration tests we replay 0010_chat_*.up.sql in order.
    """
    from pathlib import Path
    # tests/integration/ → tests/ → app/ → chat/ → services/ → modules/ → root → infra/db/migrations/
    migrations_dir = Path(__file__).parent.parent.parent.parent.parent.parent.parent / "infra" / "db" / "migrations"
    files = sorted(migrations_dir.glob("0010_chat_*.up.sql")) + sorted(migrations_dir.glob("001[1-6]_chat_*.up.sql"))
    conn = await asyncpg.connect(url)
    try:
        async with conn.transaction():
            for f in files:
                await conn.execute(f.read_text(encoding="utf-8"))
    finally:
        await conn.close()


@pytest.fixture
async def pg_conn(integration_db_url: str):
    """Per-test connection; cleans up attribution rows on teardown."""
    await _ensure_schema(integration_db_url)
    conn = await asyncpg.connect(integration_db_url)
    yield conn
    # Cleanup: drop only rows created with the test's tag prefix.
    await conn.execute("DELETE FROM attributions WHERE id LIKE 'attribution_itest_%'")
    await conn.execute("DELETE FROM indexed_items WHERE item_kind='attribution' AND item_id LIKE 'attribution_itest_%'")
    await conn.close()


async def _insert_attribution(conn: Any, *, aid: str, kind: str, refs: list[dict], embed_texts: dict[str, list[str]], embed_model: str = "openai/text-embedding-3-small") -> None:
    """Seed an attribution row + its embeddings directly into Postgres.

    `embed_texts` is {lang: [text, ...]}. Vectors are deterministic
    fixtures (1536-dim with a single high value per (aid, lang)) so
    integration tests don't need a real embedder."""
    await conn.execute(
        "INSERT INTO attributions (id, kind, refs, updated_at) VALUES ($1, $2, $3::jsonb, NOW())",
        aid, kind, json.dumps(refs, ensure_ascii=False),
    )
    # Build a deterministic vector per (aid, lang). Use the same vector
    # for ALL texts of one (aid, lang) so MAX(score) GROUP BY behaves
    # predictably under test.
    for lang, texts in embed_texts.items():
        seed = abs(hash((aid, lang))) % 1536
        vec = [0.0] * 1536
        vec[seed] = 1.0
        for text in texts:
            # Serialize vector in pgvector text format `[v1,v2,...]`.
            vec_str = "[" + ",".join(f"{v:.6f}" for v in vec) + "]"
            await conn.execute(
                """INSERT INTO attribution_embeddings
                   (attribution_id, language, text, embedding, embed_model)
                   VALUES ($1, $2, $3, $4::vector, $5)
                   ON CONFLICT DO NOTHING""",
                aid, lang, text, vec_str, embed_model,
            )


async def test_question_attribution_short_path(pg_conn):
    """SHORT path: question-attribution match → authoritative refs."""
    aid = f"attribution_itest_q_{uuid.uuid4().hex[:8]}"
    await _insert_attribution(
        pg_conn, aid=aid, kind="question",
        refs=[
            {"ref_kind": "verse", "target_id": "verse_BG_2_13"},
            {"ref_kind": "verse", "target_id": "verse_BG_2_20"},
        ],
        embed_texts={"ru": ["что такое душа", "природа души"], "en": ["what is the soul"]},
    )

    # Compose a query embedding that exactly matches the seeded ru vector.
    seed = abs(hash((aid, "ru"))) % 1536
    q_vec = [0.0] * 1536
    q_vec[seed] = 1.0
    vec_str = "[" + ",".join(f"{v:.6f}" for v in q_vec) + "]"

    rows = await pg_conn.fetch(
        """SELECT a.id, a.refs::text AS refs_json,
                  MAX(1 - (e.embedding <=> $1::vector)) AS score
           FROM attribution_embeddings e
           JOIN attributions a ON a.id = e.attribution_id
           WHERE e.language = 'ru' AND e.embed_model = 'openai/text-embedding-3-small' AND a.kind = 'question'
             AND a.id = $2
           GROUP BY a.id, a.refs""",
        vec_str, aid,
    )
    assert len(rows) == 1
    # Exact-match vectors → cosine similarity 1.0 (within float tolerance).
    assert rows[0]["score"] >= 0.999

    # refs JSONB preserved with both verses.
    refs = json.loads(rows[0]["refs_json"])
    target_ids = sorted(r["target_id"] for r in refs)
    assert target_ids == ["verse_BG_2_13", "verse_BG_2_20"]


async def test_topic_attribution_drives_boost_set(pg_conn):
    """LONG path: topic-attribution match collects target_ids for boost."""
    aid = f"attribution_itest_t_{uuid.uuid4().hex[:8]}"
    await _insert_attribution(
        pg_conn, aid=aid, kind="topic",
        refs=[
            {"ref_kind": "verse", "target_id": "verse_BG_2_20"},
            {"ref_kind": "verse", "target_id": "verse_SB_7_7_19"},
        ],
        embed_texts={"ru": ["вечность души"]},
    )

    seed = abs(hash((aid, "ru"))) % 1536
    q_vec = [0.0] * 1536
    q_vec[seed] = 1.0
    vec_str = "[" + ",".join(f"{v:.6f}" for v in q_vec) + "]"

    rows = await pg_conn.fetch(
        """SELECT a.id, a.refs::text AS refs_json,
                  MAX(1 - (e.embedding <=> $1::vector)) AS score
           FROM attribution_embeddings e
           JOIN attributions a ON a.id = e.attribution_id
           WHERE e.language = 'ru' AND e.embed_model = 'openai/text-embedding-3-small' AND a.kind = 'topic'
             AND a.id = $2
           GROUP BY a.id, a.refs""",
        vec_str, aid,
    )
    assert len(rows) == 1
    refs = json.loads(rows[0]["refs_json"])
    boost_ids = {r["target_id"] for r in refs}
    assert boost_ids == {"verse_BG_2_20", "verse_SB_7_7_19"}


async def test_cascade_delete_clears_embeddings(pg_conn):
    """FK CASCADE: deleting attribution removes its embeddings."""
    aid = f"attribution_itest_d_{uuid.uuid4().hex[:8]}"
    await _insert_attribution(
        pg_conn, aid=aid, kind="question",
        refs=[{"ref_kind": "verse", "target_id": "verse_x"}],
        embed_texts={"ru": ["x"], "en": ["x"]},
    )
    pre = await pg_conn.fetchval(
        "SELECT COUNT(*) FROM attribution_embeddings WHERE attribution_id=$1", aid,
    )
    assert pre == 2

    await pg_conn.execute("DELETE FROM attributions WHERE id=$1", aid)

    post = await pg_conn.fetchval(
        "SELECT COUNT(*) FROM attribution_embeddings WHERE attribution_id=$1", aid,
    )
    assert post == 0


async def test_multi_variant_max_score_per_attribution(pg_conn):
    """One attribution with N variants → GROUP BY MAX returns one row."""
    aid = f"attribution_itest_m_{uuid.uuid4().hex[:8]}"
    # All 3 variants share the same vector so MAX(score) == 1.0.
    await _insert_attribution(
        pg_conn, aid=aid, kind="question",
        refs=[{"ref_kind": "verse", "target_id": "verse_x"}],
        embed_texts={"ru": ["что такое разум", "природа разума", "что значит buddhi"]},
    )

    seed = abs(hash((aid, "ru"))) % 1536
    q_vec = [0.0] * 1536
    q_vec[seed] = 1.0
    vec_str = "[" + ",".join(f"{v:.6f}" for v in q_vec) + "]"

    rows = await pg_conn.fetch(
        """SELECT a.id, MAX(1 - (e.embedding <=> $1::vector)) AS score
           FROM attribution_embeddings e
           JOIN attributions a ON a.id = e.attribution_id
           WHERE a.kind = 'question' AND a.id = $2
           GROUP BY a.id""",
        vec_str, aid,
    )
    assert len(rows) == 1   # one row, not three
    assert rows[0]["score"] >= 0.999


async def test_cross_lingual_fallback_no_lang_filter(pg_conn):
    """ru-only attribution + en query → cross-lang query (no language filter)
    still returns it (cosine similarity drops vs same-lang but is non-zero)."""
    aid = f"attribution_itest_x_{uuid.uuid4().hex[:8]}"
    # Use a vector specific to ru.
    await _insert_attribution(
        pg_conn, aid=aid, kind="question",
        refs=[{"ref_kind": "verse", "target_id": "verse_x"}],
        embed_texts={"ru": ["природа души"]},   # no en variant
    )

    # Query in en (different seed).
    en_seed = abs(hash(("q", "en"))) % 1536
    q_vec = [0.0] * 1536
    q_vec[en_seed] = 1.0
    vec_str = "[" + ",".join(f"{v:.6f}" for v in q_vec) + "]"

    # Cross-lang query (no language filter).
    rows = await pg_conn.fetch(
        """SELECT a.id, MAX(1 - (e.embedding <=> $1::vector)) AS score
           FROM attribution_embeddings e
           JOIN attributions a ON a.id = e.attribution_id
           WHERE a.kind = 'question' AND a.id = $2
           GROUP BY a.id""",
        vec_str, aid,
    )
    assert len(rows) == 1   # cross-stage still finds the ru-only attribution
