"""ChunkRepository — port for transcript-chunk reads.

Two query shapes the application needs today:

- `search_by_embedding` — ANN over `chunks` with optional language and
  track-id allowlist. Returns chunks scored by cosine similarity.
- `get_window` — chunks around a timecode for citation context.

The port is intentionally narrow. New use-cases can extend it; we don't
expose generic "execute_sql" methods.
"""

from __future__ import annotations

from typing import Protocol

from lectorium_chat.domain.entities import Chunk, ScoredChunk


class ChunkRepository(Protocol):
    async def search_by_embedding(
        self,
        embedding: list[float],
        *,
        eligible_track_ids: list[str] | None,
        lang: str | None,
        top_k: int,
    ) -> list[ScoredChunk]:
        """ANN search over `chunks`. Implementations apply the active
        `embed_model` filter internally so callers don't need to know
        which embedder produced the vector."""
        ...

    async def get_window(
        self,
        track_id: str,
        around_ms: int,
        *,
        window_ms: int,
        lang: str | None,
        max_chunks: int,
    ) -> list[Chunk]:
        """Chunks whose [start_ms, end_ms] overlaps
        [around_ms - window_ms, around_ms + window_ms]."""
        ...
