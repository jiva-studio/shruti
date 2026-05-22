"""chunks_search — unified semantic ANN over lectures + library.

Replaces `search_transcripts`, `search_verses`, `search_documents` and
the cross-type "concept fan-out" pattern. One tool, one `type` switch:

- `type='lecture'`   → ANN over transcript chunks (catalog filters
                       apply: author/location/tag/date).
- `type='verse'`     → ANN over canonical verses (shlokas).
- `type='commentary' / 'prose_chapter' / 'letter'` → ANN over the
                       respective library subset.
- `type=None`        → run both branches (lecture + library) and
                       merge top-K by score.

Returns `ChunkEnvelope` rows. Lecture entries carry a `ref` the LLM
uses in `[^N]`; verse entries carry a `ref` used in the SSE
verse_payload path (the LLM still emits `[verse:source_id/tokens|...]`
markers directly from meta).
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
)
from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.domain.ports.chunk_repository import ChunkRepository
from shruti_chat.domain.ports.embedder import EmbedderPort


_LIBRARY_KINDS = ("verse", "commentary", "prose_chapter", "letter")
_ALL_TYPES = ("lecture",) + _LIBRARY_KINDS


_DESCRIPTION = (
    "Semantic search across lectures and library content (verses, "
    "commentaries, prose chapters, letters). Pass `type` to restrict to "
    "one corpus (e.g. `type='verse'` for 'find a shloka about X', "
    "`type='lecture'` for 'where did he say'), or OMIT `type` for "
    "cross-corpus search ('what's said about consciousness' — returns "
    "lectures AND verses ranked together by relevance). Every result is "
    "cited via `[^N]` (integer ref). Commentary results additionally "
    "support `[^N|s=0,2]` to pick which sentences of the chunk get "
    "rendered as a verbatim blockquote with author attribution. NEVER "
    "hand-write `>` blockquotes — the server strips them. For an EXACT "
    "verse address ('БГ 2.13') use `chunks_get_by_address` — ANN over a "
    "short address string is unreliable."
)


async def chunks_search(
    query: str,
    type: str | None = None,
    lang: str | None = None,
    author_id: str | None = None,
    location_id: str | None = None,
    tag_ids: list[str] | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    top_k: int = 8,
    *,
    chunk_repo: ChunkRepository,
    catalog_repo: CatalogRepository,
    embedder: EmbedderPort,
    alias_map: TurnAliasMap,
    # Python-only kwargs — not in LLM schema. Catalog ids are opaque
    # (e.g. `source_dsicuBsFvinZ`); the LLM doesn't know them and would
    # pass shortnames that miss everything. Kept on the signature for
    # internal callers / tests that DO have real ids.
    book_id: str | None = None,
    referenced_source_id: str | None = None,
) -> list[dict[str, Any]]:
    if type is not None and type not in _ALL_TYPES:
        return []

    q_vec = await embedder.embed_query(query)
    k = max(1, min(top_k, 16))

    async def _lecture_branch(use_lang: str | None) -> list[dict[str, Any]]:
        eligible_ids = await catalog_repo.filter_track_ids(
            author_id=author_id,
            source_id=referenced_source_id,
            location_id=location_id,
            tag_ids=tag_ids,
            date_from=date_from,
            date_to=date_to,
        )
        if eligible_ids is not None and not eligible_ids:
            return []
        scored = await chunk_repo.search_by_embedding(
            q_vec,
            eligible_track_ids=eligible_ids,
            lang=use_lang,
            top_k=k,
        )
        return [
            lecture_to_envelope(s.chunk, alias_map=alias_map, score=s.score)
            for s in scored
        ]

    async def _library_branch(
        use_lang: str | None, kinds: list[str],
    ) -> list[dict[str, Any]]:
        scored = await chunk_repo.search_library_by_embedding(
            q_vec,
            kinds=kinds,
            source_id=book_id,
            author_id=author_id,
            lang=use_lang,
            date_from=date_from,
            date_to=date_to,
            top_k=k,
        )
        return [
            library_to_envelope(s.chunk, alias_map=alias_map, score=s.score)
            for s in scored
        ]

    async def _run(use_lang: str | None) -> list[dict[str, Any]]:
        if type == "lecture":
            return await _lecture_branch(use_lang)
        if type in _LIBRARY_KINDS:
            return await _library_branch(use_lang, [type])
        # type is None → fan out to both, merge.
        lectures = await _lecture_branch(use_lang)
        library = await _library_branch(use_lang, list(_LIBRARY_KINDS))
        merged = lectures + library
        merged.sort(key=lambda e: e.get("score") or 0.0, reverse=True)
        return merged[:k]

    rows = await _run(lang)
    if not rows and lang is not None:
        # Strict lang produced nothing; relax both branches together to
        # avoid mixing strict-ru with relaxed-en in one merged result.
        rows = await _run(None)

    # Relevance floor. HNSW returns top-K regardless of similarity, so
    # an off-topic query (quantum computers / aliens / modern science)
    # still gets 8 unrelated chunks back at score 0.3-0.45. The
    # synthesizer would then compose paragraphs from junk. Cut at 0.45:
    # empirically relevant matches sit at 0.5+, mid-relevance 0.45-0.5,
    # noise below 0.45. Empty list → synth follows refusal rule.
    return [r for r in rows if (r.get("score") or 0.0) >= 0.45]


register_tool(ToolDef(
    name="chunks_search",
    fn=chunks_search,
    description=_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "type": {
                "type": "string",
                "enum": list(_ALL_TYPES),
                "description": (
                    "Restrict to a single corpus. Omit for cross-corpus "
                    "search (lectures + all library kinds ranked together)."
                ),
            },
            "lang":         {"type": "string", "enum": ["ru", "en"]},
            "author_id":    {"type": "string"},
            "location_id":  {"type": "string", "description": "Lecture-only filter."},
            "tag_ids":      {"type": "array", "items": {"type": "string"}, "description": "Lecture-only filter."},
            "date_from":    {"type": "string", "description": "YYYY-MM-DD"},
            "date_to":      {"type": "string", "description": "YYYY-MM-DD"},
            "top_k":        {"type": "integer", "default": 8},
        },
        "required": ["query"],
    },
))
