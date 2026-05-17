"""get_transcript_window — chunks around a timecode.

Used when the agent has one citation (track_id @ start_ms) and needs the
surrounding fragment to explain context. Delegates to `ChunkRepository`
so this module knows nothing about SQL.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.domain.ports.chunk_repository import ChunkRepository


MAX_CHUNKS = 6


async def get_transcript_window(
    track_id: str,
    around_ms: int,
    window_seconds: int = 60,
    lang: str | None = None,
    *,
    chunk_repo: ChunkRepository,
) -> list[dict[str, Any]]:
    chunks = await chunk_repo.get_window(
        track_id,
        int(around_ms),
        window_ms=max(window_seconds, 5) * 1000,
        lang=lang,
        max_chunks=MAX_CHUNKS,
    )
    return [
        {
            "track_id": c.track_id,
            "lang": c.lang,
            "start_ms": c.start_ms,
            "end_ms": c.end_ms,
            "text": c.text,
            "reference_source_id": c.reference_source_id,
        }
        for c in chunks
    ]


TOOL_REGISTRY = [
    {
        "name": "get_transcript_window",
        "fn": get_transcript_window,
        "personalized": False,
        "description": (
            "Fetch transcript chunks within ±window_seconds of a given timecode "
            "to enrich context around an existing citation."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "track_id": {"type": "string"},
                "around_ms": {"type": "integer"},
                "window_seconds": {"type": "integer", "default": 60},
                "lang": {"type": "string", "enum": ["ru", "en"]},
            },
            "required": ["track_id", "around_ms"],
        },
    },
]
