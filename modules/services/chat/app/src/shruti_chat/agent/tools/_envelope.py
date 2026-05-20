"""Build LLM-facing `ChunkEnvelope` dicts from domain entities.

Every chunks_* / user_* tool that returns chunks calls into here to
mint a `ref` via `TurnAliasMap` and assemble the type-discriminated
envelope. Output is a plain `dict` (JSON-ready); the `ChunkEnvelope`
dataclass in `domain/entities.py` documents the shape.

Lecture chunks have their `track_id` stripped from the LLM-visible
payload — the model only sees `ref`, and the marker expander resolves
`[cite:N|...]` back to the real `track_id` server-side. Library chunks
(verse / commentary / letter / prose) keep `source_id`+`tokens` in
meta so the model can emit `[verse:source_id/tokens|...]` directly.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.entities import Chunk, LibraryChunk


def _format_hms(ms: int) -> str:
    """Milliseconds → `HH:MM:SS` (or `MM:SS` if under an hour)."""
    total_s = max(0, int(ms)) // 1000
    h, rem = divmod(total_s, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def _lecture_label(start_ms: int, end_ms: int) -> str:
    """Time-window label for a lecture chunk.

    Track-level metadata (date, location) isn't joined in here to keep
    the call cheap — search returns dozens of chunks and we don't want
    a catalog lookup per row. The label becomes "Lecture [12:00–12:45]"
    which is enough for the LLM to disambiguate; richer track context
    is fetched on demand via `chunks_get_window` or list_tracks.
    """
    return f"Lecture [{_format_hms(start_ms)}–{_format_hms(end_ms)}]"


def lecture_to_envelope(
    chunk: Chunk, *, alias_map: TurnAliasMap, score: float | None = None,
) -> dict[str, Any]:
    """Mint a fresh ref for the chunk and assemble an LLM-facing dict.

    `track_id` is intentionally NOT in the output — the LLM uses `ref`
    everywhere. The marker expander resolves `[cite:N|...]` server-side
    using `alias_map.resolve(N)` to recover the real `track_id`.
    """
    ref = alias_map.alias_chunk(chunk.track_id, chunk.start_ms, chunk.end_ms)
    meta: dict[str, Any] = {"start_ms": chunk.start_ms, "end_ms": chunk.end_ms}
    if chunk.reference_source_id:
        meta["reference_source_id"] = chunk.reference_source_id
    return {
        "type": "lecture",
        "ref": ref,
        "label": _lecture_label(chunk.start_ms, chunk.end_ms),
        "text": chunk.text,
        "lang": chunk.lang,
        "score": score,
        "meta": meta,
    }


def library_to_envelope(
    chunk: LibraryChunk, *, alias_map: TurnAliasMap, score: float | None = None,
) -> dict[str, Any]:
    """Mint a fresh ref and assemble an LLM-facing dict.

    For verses, `meta.source_id`+`meta.tokens` are visible to the model
    — it uses them in `[verse:source_id/tokens|...]` markers (the verse
    marker shape predates ref-based citations and stays as-is). `ref`
    is included for shape uniformity and as a verse alias the SSE
    layer can resolve into a `verse_payload` event.

    For commentary / letter / prose_chapter the model cites via
    `[cite:N|...]` like lectures, but `source_id`+`tokens` stay in meta
    so attribution captions and follow-up tool calls have the data.
    """
    meta: dict[str, Any] = {}
    item_kind = chunk.item_kind
    ref: int | None
    if item_kind == "verse":
        ref = alias_map.alias_verse(chunk.source_id, chunk.tokens, addr_label=chunk.addr_label)
        meta["source_id"] = chunk.source_id
        meta["tokens"] = chunk.tokens
    else:
        # commentary / letter / prose_chapter: no citation marker
        # protocol exists for these — the LLM quotes them inline. Skip
        # the alias step; meta carries the attribution data.
        ref = None
        if chunk.source_id:
            meta["source_id"] = chunk.source_id
        if chunk.tokens:
            meta["tokens"] = chunk.tokens
        if chunk.author_id:
            meta["author_id"] = chunk.author_id
        if chunk.doc_date:
            meta["doc_date"] = chunk.doc_date
    return {
        "type": item_kind,
        "ref": ref,
        "label": chunk.addr_label,
        "text": chunk.text,
        "lang": chunk.lang,
        "score": score,
        "meta": meta,
    }
