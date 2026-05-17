"""search_transcripts — semantic ANN over `chunks` with metadata filters.

Flow:
1. If any catalog-side filter is set (author/source/location/tag/date),
   compute the eligible track_id set via `CatalogRepository.filter_track_ids`.
2. Embed the query via the active embedder.
3. Delegate to `ChunkRepository.search_by_embedding` for the ANN call.

Postgres + SQLite access are both encapsulated by repositories — this
module no longer imports `db.client` or the sqlite helper.
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.domain.ports.catalog_repository import CatalogRepository
from lectorium_chat.domain.ports.chunk_repository import ChunkRepository
from lectorium_chat.domain.ports.embedder import EmbedderPort


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
    *,
    chunk_repo: ChunkRepository,
    catalog_repo: CatalogRepository,
    embedder: EmbedderPort,
) -> list[dict[str, Any]]:
    eligible_ids = await catalog_repo.filter_track_ids(
        author_id=author_id, source_id=source_id, location_id=location_id,
        tag_ids=tag_ids, date_from=date_from, date_to=date_to,
    )
    if eligible_ids is not None and not eligible_ids:
        # Filter matched no tracks → no semantic search needed.
        return []

    q_vec = await embedder.embed_query(query)

    async def _run(use_lang: str | None) -> list[dict[str, Any]]:
        scored = await chunk_repo.search_by_embedding(
            q_vec,
            eligible_track_ids=eligible_ids,
            lang=use_lang,
            top_k=top_k,
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

    # Prefer the requested language; if nothing matches, transparently
    # broaden to any-language chunks. The LLM sees each chunk's real
    # `lang` field and can warn the user accordingly.
    rows = await _run(lang)
    if not rows and lang is not None:
        rows = await _run(None)
    return rows


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
