"""find_similar_chunks — ANN over pgvector excluding the source track.

Two modes:
- Fragment mode: caller supplies `track_id + start_ms + end_ms`. The
  chunks inside that window are re-embedded as one query and matched
  against the rest of the corpus. Use for "where else did he say
  something similar" given an existing citation.
- Whole-track mode: caller supplies just `track_id`. The first ~5
  chunks of the track are used as the seed instead — same query
  shape, broader anchor. Use for "find lectures like this one"
  without a specific timecode.
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.db.client import get_pool
from lectorium_chat.indexer.embed import get_embedder


async def find_similar_chunks(
    track_id: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    top_k: int = 6,
    lang: str | None = None,
) -> list[dict[str, Any]]:
    pool = get_pool()

    # Fetch source chunks. With a (start_ms, end_ms) window we anchor on
    # that fragment; without one we take the first 5 chunks of the track
    # as a "what's this track about" centroid.
    where_src: list[str] = ["track_id = $1"]
    params_src: list[Any] = [track_id]
    if start_ms is not None and end_ms is not None:
        where_src.append(f"end_ms >= ${len(params_src) + 1}")
        params_src.append(int(start_ms))
        where_src.append(f"start_ms <= ${len(params_src) + 1}")
        params_src.append(int(end_ms))
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


TOOL_REGISTRY = [
    {
        "name": "find_similar_chunks",
        "fn": find_similar_chunks,
        "personalized": False,
        "description": (
            "Find passages in OTHER tracks semantically similar to either a "
            "fragment or a whole track. Two call shapes:\n"
            "- Fragment: pass `track_id + start_ms + end_ms`. Returns chunks "
            "similar to the audio inside that window. Use for "
            "'where else did he say something similar' on a specific citation.\n"
            "- Whole track: pass just `track_id` (omit start_ms/end_ms). "
            "Returns chunks similar to the start of that lecture. Use for "
            "'recommend something like this lecture' without a timecode."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "track_id": {"type": "string"},
                "start_ms": {"type": "integer"},
                "end_ms": {"type": "integer"},
                "top_k": {"type": "integer", "default": 6},
                "lang": {"type": "string", "enum": ["ru", "en"]},
            },
            "required": ["track_id"],
        },
    },
]
