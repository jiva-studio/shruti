"""Wrap registered tools so their outputs use integer refs instead of
real `track_id`s, and so action tools accept integer refs from the
LLM and translate them back.

This is the moving part of the numbered-refs protocol: the model only
ever sees integers, the agent owns the integer↔track_id mapping for
the duration of one turn, and the catalog stays the single source of
truth — we just don't expose the catalog's id format to the model.
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.agent.tools._registry import ToolFn
from lectorium_chat.agent.turn_aliases import TurnAliasMap


# ── Tools whose RESULT carries one or more {track_id, [start_ms,
# end_ms]} entries that we need to alias before showing to the LLM.
# Each entry says "this tool's result is a list of dicts, alias each
# dict's chunk reference". For single-entity returns (`get_track`),
# the wrapper treats a non-list result the same way.

# Tools that return list-of-chunks (track_id + start_ms + end_ms each):
_CHUNK_LIST_TOOLS = frozenset({
    "search_transcripts",
    "find_similar_chunks",
    "search_my_history",
    "get_transcript_window",
})

# Tools that return list-of-tracks (whole-track entities — track_id
# only, no chunk timestamps):
_TRACK_LIST_TOOLS = frozenset({
    "list_tracks",
    "list_my_tracks",
    "recommend_next",
})

# Single-track tools (one dict, not a list):
_TRACK_SINGLE_TOOLS = frozenset({
    "get_track",
})

# Tools that take track_id as input — LLM passes integer refs, we
# de-alias before the underlying tool call.
_ACCEPTS_TRACK_REFS = {
    # tool_name → list of arg names that carry track-id lists
    "propose_playlist": ["track_ids"],
    "generate_track_pdf": ["track_ids"],
}

# Tools that take a single track_id input arg:
_ACCEPTS_TRACK_REF_SINGLE = {
    # tool_name → arg name carrying single track_id
    "get_track": "track_id",
    "get_track_outline": "track_id",
    "get_transcript_window": "track_id",
    "find_similar_chunks": "track_id",
}


def _alias_chunk_entry(entry: dict[str, Any], aliases: TurnAliasMap) -> dict[str, Any]:
    """One chunk dict → replace track_id with integer ref. Keep
    start_ms / end_ms in the model-facing payload so the model can
    still reason about position in a track if it wants, BUT we use the
    server-side mapping for the marker expansion (we don't trust
    timestamps the model might invent)."""
    tid = entry.get("track_id")
    start = entry.get("start_ms")
    end = entry.get("end_ms")
    if not isinstance(tid, str) or not isinstance(start, int) or not isinstance(end, int):
        # Shape we don't recognise — leave as-is.
        return entry
    ref = aliases.alias_chunk(tid, start, end)
    out = dict(entry)
    out.pop("track_id", None)
    out["ref"] = ref
    return out


def _alias_track_entry(entry: dict[str, Any], aliases: TurnAliasMap) -> dict[str, Any]:
    """Whole-track dict — replace track_id with integer ref."""
    tid = entry.get("track_id")
    if not isinstance(tid, str):
        return entry
    ref = aliases.alias_track(tid)
    out = dict(entry)
    out.pop("track_id", None)
    out["ref"] = ref
    return out


def _alias_result(name: str, result: Any, aliases: TurnAliasMap) -> Any:
    if name in _CHUNK_LIST_TOOLS:
        if not isinstance(result, list):
            return result
        return [_alias_chunk_entry(e, aliases) if isinstance(e, dict) else e for e in result]
    if name in _TRACK_LIST_TOOLS:
        if not isinstance(result, list):
            return result
        return [_alias_track_entry(e, aliases) if isinstance(e, dict) else e for e in result]
    if name in _TRACK_SINGLE_TOOLS:
        if isinstance(result, dict):
            return _alias_track_entry(result, aliases)
    return result


def _dealias_args(name: str, kwargs: dict[str, Any], aliases: TurnAliasMap) -> dict[str, Any]:
    """Convert any integer-ref arguments back to real track_ids before
    the underlying tool call. Unknown refs are silently dropped (we
    log on the wrapper side if needed)."""
    if name in _ACCEPTS_TRACK_REFS:
        out = dict(kwargs)
        for arg_name in _ACCEPTS_TRACK_REFS[name]:
            refs = out.get(arg_name)
            if isinstance(refs, list):
                out[arg_name] = aliases.dealias_many(refs)
        return out
    single = _ACCEPTS_TRACK_REF_SINGLE.get(name)
    if single is not None:
        val = kwargs.get(single)
        if isinstance(val, int) or (isinstance(val, str) and val.isdigit()):
            real = aliases.dealias_many([int(val)])
            if real:
                out = dict(kwargs)
                out[single] = real[0]
                return out
    return kwargs


def build_aliased_tools(
    base: dict[str, ToolFn], aliases: TurnAliasMap,
) -> dict[str, ToolFn]:
    """Wrap every relevant tool so:
      - outputs that carry track_ids are post-processed to use
        integer refs (alias minted into `aliases`),
      - inputs that carry track_ids accept integer refs and are
        de-aliased before the real tool runs.

    Tools not in either list pass through unchanged. The wrapper is
    a thin async closure — no behaviour change for unrelated tools.
    """

    def _make(name: str, fn: ToolFn) -> ToolFn:
        async def _wrapped(**kwargs: Any) -> Any:
            real_kwargs = _dealias_args(name, kwargs, aliases)
            raw = await fn(**real_kwargs)
            return _alias_result(name, raw, aliases)

        return _wrapped

    relevant = (
        _CHUNK_LIST_TOOLS
        | _TRACK_LIST_TOOLS
        | _TRACK_SINGLE_TOOLS
        | _ACCEPTS_TRACK_REFS.keys()
        | _ACCEPTS_TRACK_REF_SINGLE.keys()
    )
    out = dict(base)
    for name, fn in base.items():
        if name in relevant:
            out[name] = _make(name, fn)
    return out
