"""Core domain entities — the lecture corpus broken into Tracks and Chunks.

These are *domain* shapes: independent of HTTP wire format and of the
underlying SQL schema. Adapters in `infra/` build them from rows;
application/tool code consumes them as Python objects.

`Chunk` is what semantic search and transcript-window queries return.
`Track` is a single lecture with its denormalised author / location /
tags / references in the caller's preferred language; the adapter
handles the join + fallback dance.

`ResolvedEntity` is the result of a fuzzy dictionary lookup
(author / source / location / tag); `extra` carries kind-specific
fields (e.g. `short_name` for sources).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


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


@dataclass(frozen=True, slots=True)
class LibraryChunk:
    """A chunk of canonical library content (verse / commentary / prose chapter / letter)."""
    item_id: str
    item_kind: str           # 'verse' | 'commentary' | 'prose_chapter' | 'letter'
    source_id: str
    tokens: str
    author_id: str | None
    doc_date: str | None
    lang: str
    segment_index: int
    text: str
    addr_label: str


@dataclass(frozen=True, slots=True)
class ScoredLibraryChunk:
    chunk: LibraryChunk
    score: float


@dataclass(frozen=True, slots=True)
class ChunkEnvelope:
    """Unified LLM-facing chunk result.

    Every chunks_* / user_* tool that returns chunks emits a list of
    these. The shape is type-discriminated:

    - `type='lecture'`   → ref is set; meta has `start_ms`, `end_ms`,
                           optionally `reference_source_id`. `track_id`
                           is intentionally absent — the LLM only sees
                           `ref` and uses it in `[cite:N|...]` markers
                           (server expands ref → track_id at output time).
    - `type='verse'`     → ref is set; meta has `source_id`, `tokens`.
                           The LLM uses meta directly in
                           `[verse:source_id/tokens|caption]` markers
                           (NOT the ref). Ref is also used as a verse
                           alias to drive the `verse_payload` SSE event.
    - `type='commentary' / 'prose_chapter' / 'letter'` → ref is None
                           (no citation marker protocol exists for
                           these — the LLM quotes them inline). Meta
                           has `source_id?`, `tokens?`, `author_id?`,
                           `doc_date?` for attribution captions.

    `score` is set for semantic-search results; None for exact-lookup
    and time-window results.
    """

    type: str
    ref: int | None
    label: str
    text: str
    lang: str
    score: float | None
    meta: dict[str, Any]



@dataclass(frozen=True, slots=True)
class Reference:
    source_id: str
    full_name: str | None
    short_name: str | None
    tokens: str | None


@dataclass(frozen=True, slots=True)
class Track:
    id: str
    title: str | None
    lang: str
    date: str | None
    author_id: str | None
    author_name: str | None
    location_id: str | None
    location_name: str | None
    tag_ids: tuple[str, ...]
    tag_names: tuple[str, ...]
    duration_ms: int | None
    references: tuple[Reference, ...]
    # Available transcript-variant languages. Populated by `get_track`;
    # `list_tracks` leaves this empty since the row form does not need
    # all variant languages per result.
    languages: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ResolvedEntity:
    id: str
    full_name: str
    confidence: float
    extra: dict[str, Any] = field(default_factory=dict)
