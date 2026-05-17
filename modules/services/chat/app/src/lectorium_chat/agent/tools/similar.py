"""find_similar_chunks — ANN over pgvector excluding the source track.

Two modes:
- Fragment mode: caller supplies `track_id + start_ms + end_ms`. The
  chunks inside that window are re-embedded as one query and matched
  against the rest of the corpus.
- Whole-track mode: caller supplies just `track_id`. The first ~5
  chunks of the track are used as the seed instead — same query
  shape, broader anchor.

Anchored use-case: language is set by the source citation, so the
language filter stays strict (no lang fallback like the discovery
tools do).
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.domain.ports.chunk_repository import ChunkRepository
from lectorium_chat.domain.ports.embedder import EmbedderPort


ANCHOR_LIMIT = 5


async def find_similar_chunks(
    track_id: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
    top_k: int = 6,
    lang: str | None = None,
    *,
    chunk_repo: ChunkRepository,
    embedder: EmbedderPort,
) -> list[dict[str, Any]]:
    src_texts = await chunk_repo.get_anchor_texts(
        track_id,
        start_ms=start_ms, end_ms=end_ms, lang=lang,
        limit=ANCHOR_LIMIT,
    )
    if not src_texts:
        return []
    q_vec = await embedder.embed_query(" ".join(src_texts))

    scored = await chunk_repo.search_by_embedding(
        q_vec,
        excluded_track_ids=[track_id],
        lang=lang,
        top_k=max(1, min(top_k, 12)),
    )
    return [
        {
            "track_id": s.chunk.track_id,
            "lang": s.chunk.lang,
            "start_ms": s.chunk.start_ms,
            "end_ms": s.chunk.end_ms,
            "text": s.chunk.text,
            "reference_source_id": s.chunk.reference_source_id,
            "score": s.score,
        }
        for s in scored
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
