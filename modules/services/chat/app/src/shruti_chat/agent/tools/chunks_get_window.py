"""chunks_get_window — transcript chunks around a timecode.

Replaces `get_transcript_window`. Used when the agent already has one
citation (lecture ref + around_ms) and needs the surrounding fragment
for context — e.g. "what came before this", "expand this citation".

Accepts an integer `track_ref` (the alias minted on a previous chunks_*
call), not a raw `track_id` — the LLM never sees track_ids directly.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools._envelope import lecture_to_envelope
from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.agent.turn_aliases import ChunkRef, TurnAliasMap
from shruti_chat.domain.ports.chunk_repository import ChunkRepository


MAX_CHUNKS = 6


_DESCRIPTION = (
    "Fetch transcript chunks within ±window_seconds of a given timecode "
    "in a specific lecture. Pass `track_ref` from a previous "
    "`chunks_search(type='lecture')` result and `around_ms` from that "
    "chunk's meta. Use to enrich context around an existing citation "
    "(\"что было до этого\", \"расскажи подробнее этот фрагмент\")."
)


async def chunks_get_window(
    track_ref: int,
    around_ms: int,
    window_seconds: int = 60,
    lang: str | None = None,
    *,
    chunk_repo: ChunkRepository,
    alias_map: TurnAliasMap,
) -> list[dict[str, Any]] | dict[str, Any]:
    ref = alias_map.resolve(int(track_ref))
    if not isinstance(ref, ChunkRef) or not ref.track_id:
        return {
            "error": "invalid_ref",
            "hint": (
                f"track_ref={track_ref} is not a known lecture ref. "
                "Use a ref from a previous chunks_search(type='lecture') "
                "result."
            ),
        }
    chunks = await chunk_repo.get_window(
        ref.track_id,
        int(around_ms),
        window_ms=max(window_seconds, 5) * 1000,
        lang=lang,
        max_chunks=MAX_CHUNKS,
    )
    return [
        lecture_to_envelope(c, alias_map=alias_map) for c in chunks
    ]


register_tool(ToolDef(
    name="chunks_get_window",
    fn=chunks_get_window,
    description=_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "track_ref": {
                "type": "integer",
                "description": "Integer ref of a lecture (from prior chunks_* result).",
            },
            "around_ms":      {"type": "integer"},
            "window_seconds": {"type": "integer", "default": 60},
            "lang":           {"type": "string", "enum": ["ru", "en"]},
        },
        "required": ["track_ref", "around_ms"],
    },
))
