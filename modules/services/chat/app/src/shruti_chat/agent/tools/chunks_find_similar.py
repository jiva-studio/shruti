"""chunks_find_similar — recommend chunks similar to a lecture anchor.

Replaces `find_similar_chunks`. Two modes:

- Fragment mode: pass `track_ref + start_ms + end_ms`. Chunks inside
  that window are re-embedded as one query and matched against other
  tracks (the source track is excluded).
- Whole-track mode: pass just `track_ref`. The first ~5 chunks of the
  track are used as the anchor — broader recommendation seed.

This is intentionally NOT the same as `chunks_search(query=..., type='lecture')`
— there's no text query. The "query" is the anchor fragment's own text,
embedded.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools._envelope import lecture_to_envelope
from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.agent.turn_aliases import ChunkRef, TurnAliasMap
from shruti_chat.domain.ports.chunk_repository import ChunkRepository
from shruti_chat.domain.ports.embedder import EmbedderPort


ANCHOR_LIMIT = 5


_DESCRIPTION = (
    "Recommend chunks SIMILAR to a specific lecture fragment OR whole "
    "lecture — no text query needed. Two call shapes:\n"
    "- Fragment: pass `track_ref + start_ms + end_ms`. Returns chunks "
    "  semantically similar to the audio inside that window. Use for "
    "  'where else did he say something like this' on a citation.\n"
    "- Whole track: pass just `track_ref` (omit start_ms/end_ms). "
    "  Anchors on the lecture's opening — use for 'recommend something "
    "  like this lecture' without a specific timecode.\n"
    "The source track is always excluded from results."
)


async def chunks_find_similar(
    track_ref: int,
    start_ms: int | None = None,
    end_ms: int | None = None,
    top_k: int = 6,
    lang: str | None = None,
    *,
    chunk_repo: ChunkRepository,
    embedder: EmbedderPort,
    alias_map: TurnAliasMap,
    # The turn's author selection, supplied by the per-turn wrapper and hidden
    # from the LLM schema. "More like this" must stay inside the selection —
    # otherwise the one path that starts from a fragment escapes it.
    author_scope: Any | None = None,
) -> list[dict[str, Any]] | dict[str, Any]:
    ref = alias_map.resolve(int(track_ref))
    if not isinstance(ref, ChunkRef) or not ref.track_id:
        return {
            "error": "invalid_ref",
            "hint": (
                f"track_ref={track_ref} is not a known lecture ref. "
                "Use a ref from a previous chunks_search(type='lecture') "
                "or chunks_get_window result."
            ),
        }
    src_texts = await chunk_repo.get_anchor_texts(
        ref.track_id,
        start_ms=start_ms, end_ms=end_ms, lang=lang,
        limit=ANCHOR_LIMIT,
    )
    if not src_texts:
        return []
    q_vec = await embedder.embed_query(" ".join(src_texts))
    eligible = None if author_scope is None else await author_scope.track_ids()
    if eligible is not None and not eligible:
        return []
    scored = await chunk_repo.search_by_embedding(
        q_vec,
        eligible_track_ids=eligible,
        excluded_track_ids=[ref.track_id],
        lang=lang,
        top_k=max(1, min(top_k, 12)),
    )
    return [
        lecture_to_envelope(s.chunk, alias_map=alias_map, score=s.score)
        for s in scored
    ]


register_tool(ToolDef(
    name="chunks_find_similar",
    fn=chunks_find_similar,
    description=_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "track_ref": {
                "type": "integer",
                "description": "Integer ref of a lecture (from prior chunks_* result).",
            },
            "start_ms": {"type": "integer"},
            "end_ms":   {"type": "integer"},
            "top_k":    {"type": "integer", "default": 6},
            "lang":     {"type": "string", "enum": ["ru", "en"]},
        },
        "required": ["track_ref"],
    },
))
