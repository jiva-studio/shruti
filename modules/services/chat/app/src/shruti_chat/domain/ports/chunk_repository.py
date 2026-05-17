"""ChunkRepository — port for transcript-chunk reads.

Operations the application uses today:

- `search_by_embedding` — ANN over `chunks` with optional language,
  optional allowlist of track ids, and optional excluded track ids.
  Returns chunks scored by cosine similarity.
- `get_window` — chunks around a timecode for citation context.
- `get_anchor_texts` — raw chunk text for an anchor span; used by
  `find_similar_chunks` to build a query embedding.
- `get_first_chunk_embeddings` — one representative embedding per
  track (the first chunk's vector); used by `recommend_next` to
  compute the user's listening centroid.

The port is intentionally narrow. New use-cases extend it explicitly;
we do not expose a generic "execute SQL" method.
"""

from __future__ import annotations

from typing import Protocol

from shruti_chat.domain.entities import Chunk, ScoredChunk


class ChunkRepository(Protocol):
    async def search_by_embedding(
        self,
        embedding: list[float],
        *,
        eligible_track_ids: list[str] | None = None,
        excluded_track_ids: list[str] | None = None,
        lang: str | None,
        top_k: int,
    ) -> list[ScoredChunk]:
        """ANN search over `chunks`. Implementations apply the active
        `embed_model` filter internally."""
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

    async def get_anchor_texts(
        self,
        track_id: str,
        *,
        start_ms: int | None,
        end_ms: int | None,
        lang: str | None,
        limit: int,
    ) -> list[str]:
        """Raw chunk texts for an anchor span. When `start_ms/end_ms` is
        omitted, returns the first `limit` chunks of the track."""
        ...

    async def get_first_chunk_embeddings(
        self,
        track_ids: list[str],
        *,
        lang: str | None,
    ) -> list[list[float]]:
        """One embedding per track (the first chunk by `start_ms`).
        Tracks without a matching chunk are silently dropped."""
        ...
