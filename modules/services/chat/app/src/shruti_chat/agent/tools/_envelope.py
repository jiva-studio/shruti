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

import logging
import re
from typing import Any

from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.entities import Chunk, LibraryChunk
from shruti_chat.domain.ports.catalog_repository import CatalogRepository


log = logging.getLogger(__name__)


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


# Authored quotable kinds — all carry an `author_id` and render their
# blockquote attribution as `author, addr_label` (see `library_to_envelope`
# + `MarkerExpander._format_commentary`). `verse` is excluded: a shloka's
# attribution is its address, not a person.
_AUTHORED_KINDS = frozenset({"commentary", "prose_chapter", "letter"})


async def resolve_commentary_author_names(
    chunks: list[LibraryChunk],
    *,
    catalog_repo: CatalogRepository | None,
    lang: str | None,
) -> dict[str, str]:
    """Batch-resolve `author_id` → human full_name for authored library
    chunks (commentary / prose_chapter / letter).

    Centralises the lookup that previously lived only in
    `research/commentary_expansion.py`; the same path now runs after
    `chunks_search`'s library branch so a standalone commentary / prose /
    letter result arrives at the synthesizer with a real author name
    rather than a raw `author_id`. Best-effort: if the catalog lookup
    fails (or no catalog/lang supplied), returns an empty mapping and
    callers fall back to displaying just the address.
    """
    if catalog_repo is None or not lang:
        return {}
    ids = [
        c.author_id
        for c in chunks
        if c.author_id and c.item_kind in _AUTHORED_KINDS
    ]
    if not ids:
        return {}
    try:
        return await catalog_repo.get_author_names(list(set(ids)), lang=lang)
    except Exception as exc:  # noqa: BLE001
        log.warning("commentary_author_resolve_failed: %s", exc)
        return {}


def lecture_to_envelope(
    chunk: Chunk,
    *,
    alias_map: TurnAliasMap,
    score: float | None = None,
    sub_query_id: int | None = None,
) -> dict[str, Any]:
    """Mint a fresh ref for the chunk and assemble an LLM-facing dict.

    `track_id` is intentionally NOT in the output — the LLM uses `ref`
    everywhere. The marker expander resolves `[^N]` server-side
    using `alias_map.resolve(N)` to recover the real `track_id`.

    `label` is intentionally empty — the timecode lives in `meta` and
    rides to the client via alias_map; surfacing it in the LLM-facing
    header `[^N] Lecture [12:00–12:45]` only primed the model to copy
    timecodes into its prose, duplicating what the citation chip
    already shows.
    """
    ref = alias_map.alias_chunk(chunk.track_id, chunk.start_ms, chunk.end_ms, lang=chunk.lang)
    # Stash the exact per-chunk transcript so `flush_cite_payloads` can emit
    # the `cite_transcript` payload verbatim. This is the single mint point
    # for every in-turn lecture fragment (research, fanout, thesis
    # augmentation, ReAct tools), so the cited text always corresponds 1:1
    # to this fragment's [start_ms, end_ms] — never a wider, overlapping
    # span. Transcript chunks overlap by design (see indexer/chunker.py), so
    # a later bounds-based re-fetch can't reconstruct this exact slice.
    alias_map.chunk_texts[ref] = chunk.text
    meta: dict[str, Any] = {"start_ms": chunk.start_ms, "end_ms": chunk.end_ms}
    if chunk.reference_source_id:
        meta["reference_source_id"] = chunk.reference_source_id
    if sub_query_id is not None:
        meta["sub_query_id"] = sub_query_id
    return {
        "type": "lecture",
        "ref": ref,
        "label": "",
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
    sub_query_id: int | None = None,
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
    elif item_kind in ("commentary", "prose_chapter", "letter"):
        # All three quotable document kinds share one citation mechanism:
        # mint a ref so the LLM cites via `[^N|s=...]` and the marker
        # expander unfolds it into a verbatim blockquote with the picked
        # sentences. Sentences are split here once and stashed in the alias
        # so the expander stays a pure lookup. author_name (when present in
        # meta) is wired in by callers that have a catalog handy (e.g.
        # commentary_expansion); a fresh envelope from chunks_search has
        # only author_id and renders without the human name. The blockquote
        # attribution is language-neutral (author + addr_label), so the same
        # path works for prose chapters (e.g. the ISKCON charter) and letters
        # without any per-kind service word.
        sentences = split_into_sentences(chunk.text)
        author_name = (extra_meta or {}).get("author_name") if extra_meta else None
        ref = alias_map.alias_commentary(
            chunk.item_id,
            chunk.segment_index or 0,
            addr_label=chunk.addr_label,
            author_name=author_name,
            sentences=sentences,
            kind=item_kind,
        )
        if chunk.source_id:
            meta["source_id"] = chunk.source_id
        if chunk.tokens:
            meta["tokens"] = chunk.tokens
        if chunk.author_id:
            meta["author_id"] = chunk.author_id
        if author_name:
            meta["author_name"] = author_name
        if chunk.doc_date:
            meta["doc_date"] = chunk.doc_date
        # Expose sentence count so the synth note renderer can show
        # `[s=0]`..`[s=N-1]` markers without re-splitting.
        meta["sentences"] = sentences
    if sub_query_id is not None:
        meta["sub_query_id"] = sub_query_id
    return {
        "type": item_kind,
        "ref": ref,
        "label": chunk.addr_label,
        "text": chunk.text,
        "lang": chunk.lang,
        "score": score,
        "meta": meta,
    }
