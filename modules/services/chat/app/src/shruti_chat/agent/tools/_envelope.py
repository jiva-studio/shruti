"""Build LLM-facing `ChunkEnvelope` dicts from domain entities.

Every chunks_* / user_* tool that returns chunks calls into here to
mint a `ref` via `TurnAliasMap` and assemble the type-discriminated
envelope. Output is a plain `dict` (JSON-ready); the `ChunkEnvelope`
dataclass in `domain/entities.py` documents the shape.

Lecture chunks have their `track_id` stripped from the LLM-visible
payload — the model only sees `ref`, and the marker expander resolves
`[^N]` back to the real `track_id` server-side. Library chunks
(verse / commentary / letter / prose) keep `source_id`+`tokens` in
meta so the model can emit `[verse:source_id/tokens|...]` directly.
"""

from __future__ import annotations

import re
from typing import Any

from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.entities import Chunk, LibraryChunk


# Cyrillic / Latin sentence terminator (`.` / `!` / `?` / `…`) followed
# by whitespace and a capital letter. Conservative split — keeps short
# sentences together when boundary is ambiguous (no trailing capital).
_SENTENCE_SPLIT = re.compile(r"(?<=[\.\!\?…])\s+(?=[А-ЯA-Z\(\«\"])")


def split_into_sentences(text: str) -> list[str]:
    """Split commentary body into sentences for `[^N|s=...]` selection.
    Stable boundary heuristic — purports are well-punctuated prose, so a
    simple terminator-then-capital regex suffices. Returns trimmed,
    non-empty sentences in original order."""
    if not text:
        return []
    parts = _SENTENCE_SPLIT.split(text.strip())
    return [p.strip() for p in parts if p.strip()]


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
    everywhere. The marker expander resolves `[^N]` server-side
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
    chunk: LibraryChunk,
    *,
    alias_map: TurnAliasMap,
    score: float | None = None,
    extra_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Mint a fresh ref and assemble an LLM-facing dict.

    For verses, `meta.source_id`+`meta.tokens` are visible to the model
    — it uses them in `[verse:source_id/tokens|...]` markers (the verse
    marker shape predates ref-based citations and stays as-is). `ref`
    is included for shape uniformity and as a verse alias the SSE
    layer can resolve into a `verse_payload` event.

    For commentary / letter / prose_chapter the model cites via
    `[^N]` like lectures, but `source_id`+`tokens` stay in meta
    so attribution captions and follow-up tool calls have the data.
    """
    meta: dict[str, Any] = {}
    item_kind = chunk.item_kind
    ref: int | None
    if item_kind == "verse":
        ref = alias_map.alias_verse(chunk.source_id, chunk.tokens, addr_label=chunk.addr_label)
        meta["source_id"] = chunk.source_id
        meta["tokens"] = chunk.tokens
    elif item_kind == "commentary":
        # Mint a ref so the LLM cites via `[^N|s=...]` (server expands
        # to a verbatim blockquote with picked sentences). Sentences
        # are split here once and stashed in the alias so the marker
        # expander stays a pure lookup. author_name (when present in
        # meta) is wired in by callers that have a catalog handy (e.g.
        # commentary_expansion); a fresh envelope from chunks_search
        # has only author_id and renders without the human name.
        sentences = split_into_sentences(chunk.text)
        author_name = (extra_meta or {}).get("author_name") if extra_meta else None
        ref = alias_map.alias_commentary(
            chunk.item_id,
            chunk.segment_index or 0,
            addr_label=chunk.addr_label,
            author_name=author_name,
            sentences=sentences,
        )
        if chunk.source_id:
            meta["source_id"] = chunk.source_id
        if chunk.tokens:
            meta["tokens"] = chunk.tokens
        if chunk.author_id:
            meta["author_id"] = chunk.author_id
        if author_name:
            meta["author_name"] = author_name
        # Expose sentence count so the synth note renderer can show
        # `[s=0]`..`[s=N-1]` markers without re-splitting.
        meta["sentences"] = sentences
    else:
        # letter / prose_chapter: no marker protocol yet — quoted inline.
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
