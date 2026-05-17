"""search_transcripts — semantic ANN over `chunks` with metadata filters.

Flow:
1. If any catalog-side filter is set (author/source/location/tag/date),
   compute the eligible track_id set from SQLite first.
2. Embed the query via the active embedder.
3. ANN over pgvector, optionally constrained to track_id IN (...) and lang.
"""

from __future__ import annotations

import asyncio
from typing import Any

from lectorium_chat.agent.tools._sqlite import catalog_conn
from lectorium_chat.db.client import get_pool
from lectorium_chat.indexer.embed import get_embedder


def _filter_track_ids_sync(
    *,
    author_id: str | None,
    source_id: str | None,
    location_id: str | None,
    tag_ids: list[str] | None,
    date_from: str | None,
    date_to: str | None,
) -> list[str] | None:
    """Return list of eligible track_ids, or None if no filter is active."""
    if not any([author_id, source_id, location_id, tag_ids, date_from, date_to]):
        return None
    sql = ["SELECT t.id FROM tracks t WHERE t.hidden = 0"]
    params: list[Any] = []
    if author_id:
        sql.append("AND t.author_id = ?"); params.append(author_id)
    if location_id:
        sql.append("AND t.location_id = ?"); params.append(location_id)
    if date_from:
        sql.append("AND t.date >= ?"); params.append(date_from)
    if date_to:
        sql.append("AND t.date <= ?"); params.append(date_to)
    if tag_ids:
        ph = ",".join("?" * len(tag_ids))
        sql.append(
            f"AND EXISTS (SELECT 1 FROM track_tags "
            f"WHERE track_id = t.id AND tag_id IN ({ph}))")
        params.extend(tag_ids)
    if source_id:
        sql.append(
            "AND EXISTS (SELECT 1 FROM track_references "
            "WHERE track_id = t.id AND source_id = ?)")
        params.append(source_id)
    with catalog_conn() as conn:
        return [r["id"] for r in conn.execute("\n".join(sql), params).fetchall()]


_DESCRIPTION = (
    "Semantic search over lecture transcripts. Use for "
    "conceptual / thematic questions: 'what did he say about X', "
    "'where does he explain Y'. Returns chunks with timestamps "
    "you must cite via [cite:track_id@start_ms-end_ms]."
)


async def search_transcripts(
    query: str,
    author_id: str | None = None,
    source_id: str | None = None,
    location_id: str | None = None,
    tag_ids: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    lang: str | None = None,
    top_k: int = 8,
) -> list[dict[str, Any]]:
    eligible_ids = await asyncio.to_thread(
        _filter_track_ids_sync,
        author_id=author_id, source_id=source_id, location_id=location_id,
        tag_ids=tag_ids, date_from=date_from, date_to=date_to,
    )
    if eligible_ids is not None and not eligible_ids:
        # Filter matched no tracks → no semantic search needed.
        return []

    embedder = get_embedder()
    q_vec = await embedder.embed_query(query)

    pool = get_pool()
    where = ["embed_model = $1"]
    params: list[Any] = [embedder.name]
    if lang:
        where.append(f"lang = ${len(params) + 1}")
        params.append(lang)
    if eligible_ids is not None:
        where.append(f"track_id = ANY(${len(params) + 1}::text[])")
        params.append(eligible_ids)
    params.append(q_vec)
    params.append(top_k)
    sql = f"""
      SELECT track_id, lang, start_ms, end_ms, text, reference_source_id,
             1 - (embedding <=> ${len(params) - 1}::vector) AS score
      FROM chunks
      WHERE {' AND '.join(where)}
      ORDER BY embedding <=> ${len(params) - 1}::vector
      LIMIT ${len(params)}
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)
    return [
        {
            "track_id": r["track_id"],
            "lang": r["lang"],
            "start_ms": r["start_ms"],
            "end_ms": r["end_ms"],
            "text": r["text"],
            "reference_source_id": r["reference_source_id"],
            "score": float(r["score"]),
        }
        for r in rows
    ]


TOOL_REGISTRY = [
    {
        "name": "search_transcripts",
        "fn": search_transcripts,
        "personalized": False,
        "description": _DESCRIPTION,
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "author_id": {"type": "string"},
                "source_id": {"type": "string"},
                "location_id": {"type": "string"},
                "tag_ids": {"type": "array", "items": {"type": "string"}},
                "date_from": {"type": "string", "description": "YYYY-MM-DD"},
                "date_to": {"type": "string", "description": "YYYY-MM-DD"},
                "lang": {"type": "string", "enum": ["ru", "en"]},
                "top_k": {"type": "integer", "default": 8},
            },
            "required": ["query"],
        },
    },
]
