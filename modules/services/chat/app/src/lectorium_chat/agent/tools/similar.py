"""find_similar_chunks — ANN over pgvector excluding the source track.

Use when the user asks "where else did he say something similar" given an
existing citation (track_id @ start_ms-end_ms). The source chunks' text
gets re-embedded as one query, then matched against the corpus.
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.db.client import get_pool
from lectorium_chat.indexer.embed import get_embedder


async def find_similar_chunks(
    track_id: str,
    start_ms: int,
    end_ms: int,
    top_k: int = 6,
    lang: str | None = None,
) -> list[dict[str, Any]]:
    pool = get_pool()

    # Fetch text of source chunks (one or more if window spans several).
    where_src = ["track_id = $1", "end_ms >= $2", "start_ms <= $3"]
    params_src: list[Any] = [track_id, int(start_ms), int(end_ms)]
    if lang:
        where_src.append(f"lang = ${len(params_src) + 1}")
        params_src.append(lang)
    sql_src = f"""
      SELECT text FROM chunks
      WHERE {' AND '.join(where_src)}
      ORDER BY start_ms
      LIMIT 5
    """
    async with pool.acquire() as conn:
        src_rows = await conn.fetch(sql_src, *params_src)
    if not src_rows:
        return []
    src_text = " ".join(r["text"] for r in src_rows)

    embedder = get_embedder()
    q_vec = await embedder.embed_query(src_text)

    where = ["embed_model = $1", "track_id <> $2"]
    params: list[Any] = [embedder.name, track_id]
    if lang:
        where.append(f"lang = ${len(params) + 1}")
        params.append(lang)
    params.append(q_vec)
    params.append(max(1, min(top_k, 12)))
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
