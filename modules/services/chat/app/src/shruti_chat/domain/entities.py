"""Core domain entities — the lecture corpus broken into Tracks and Chunks.

These are *domain* shapes: independent of HTTP wire format and of the
underlying SQL schema. Adapters in `infra/` build them from rows;
application/tool code consumes them as Python objects.

`Chunk` is what semantic search and transcript-window queries return. A
`ScoredChunk` is a `Chunk` paired with a query-time relevance score —
score is not a property of the chunk itself, so it lives separately.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Chunk:
    track_id: str
    lang: str
    start_ms: int
    end_ms: int
    text: str
    reference_source_id: str | None


@dataclass(frozen=True, slots=True)
class ScoredChunk:
    chunk: Chunk
    score: float
