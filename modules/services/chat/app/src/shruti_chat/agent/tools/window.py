"""get_transcript_window — chunks around a timecode.

Used when the agent has one citation (track_id @ start_ms) and needs the
surrounding fragment to explain context. Pure SQL on `chunks`, no LLM.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.db.client import get_pool


MAX_CHUNKS = 6


async def get_transcript_window(
    track_id: str,
    around_ms: int,
    window_seconds: int = 60,
    lang: str | None = None,
) -> list[dict[str, Any]]:
    half = max(window_seconds, 5) * 1000
    lo = max(0, int(around_ms) - half)
    hi = int(around_ms) + half

    where = ["track_id = $1", "end_ms >= $2", "start_ms <= $3"]
    params: list[Any] = [track_id, lo, hi]
    if lang:
        where.append(f"lang = ${len(params) + 1}")
        params.append(lang)
    params.append(MAX_CHUNKS)

    sql = f"""
      SELECT track_id, lang, start_ms, end_ms, text, reference_source_id
      FROM chunks
      WHERE {' AND '.join(where)}
      ORDER BY start_ms
      LIMIT ${len(params)}
    """
    pool = get_pool()
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
        }
        for r in rows
    ]
