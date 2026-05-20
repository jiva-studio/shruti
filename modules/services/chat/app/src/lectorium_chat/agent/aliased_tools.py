"""Wrap registered tools so the LLM only ever sees integer refs.

Two responsibilities:

1. **Inject `alias_map` into chunks_* / user_* tools that accept it.**
   These tools mint their own envelopes and own the alias allocation
   end-to-end. The wrapper just hands them the per-turn map.

2. **Output-alias + input-dealias legacy track-shaped tools.** The
   `list_tracks` / `get_track` family still emits raw `track_id` rows
   and accepts `track_id` strings on input. The wrapper post-processes
   their results to strip `track_id` → mint integer ref, and on input
   it accepts the LLM's integer ref and de-aliases it back to a real
   `track_id` before the underlying repo call.

Both responsibilities use convention-based detection (param name suffix
or fixed legacy table) so adding a new chunks_*-tool requires no
changes here.
"""

from __future__ import annotations

import inspect
from typing import Any

from lectorium_chat.agent.tools._registry import ToolFn
from lectorium_chat.agent.turn_aliases import TurnAliasMap


# Track-list tools — they emit `{track_id, ...}` rows; the wrapper
# mints a fresh track-ref per row and strips the real id.
_TRACK_LIST_TOOLS = frozenset({
    "tracks_list",
})

# Single-track tools — one `{track_id, ...}` dict, not a list.
_TRACK_SINGLE_TOOLS = frozenset({
    "track_get",
})

# Tools that accept lists of integer refs on input. Each entry is the
# underlying arg name (kept as `track_ids` for repo-side compat).
_ACCEPTS_TRACK_REFS = {
    "playlist_propose": ["track_ids"],
    "track_pdf_generate": ["track_ids"],
}

# Tools that accept a single integer-ref input arg.
_ACCEPTS_TRACK_REF_SINGLE = {
    "track_get": "track_id",
    "track_outline_get": "track_id",
}


def _alias_track_entry(entry: dict[str, Any], aliases: TurnAliasMap) -> dict[str, Any]:
    tid = entry.get("track_id")
    if not isinstance(tid, str):
        return entry
    ref = aliases.alias_track(tid)
    out = dict(entry)
    out.pop("track_id", None)
    out["ref"] = ref
    # Tag the envelope with a synth-readable `type` so the
    # `_render_one_note` header reads `kind=lecture · ref=N` — which
    # is the shape the grounding instruction binds to `[card:N]`
    # marker emission. tracks_list raw shape has no `type` field.
    out.setdefault("type", "lecture")
    return out


def _alias_result(name: str, result: Any, aliases: TurnAliasMap) -> Any:
    if name in _TRACK_LIST_TOOLS:
        if not isinstance(result, list):
            return result
        return [
            _alias_track_entry(e, aliases) if isinstance(e, dict) else e
            for e in result
        ]
    if name in _TRACK_SINGLE_TOOLS:
        if isinstance(result, dict):
            return _alias_track_entry(result, aliases)
    return result


def _dealias_args(
    name: str, kwargs: dict[str, Any], aliases: TurnAliasMap,
) -> dict[str, Any]:
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


def _accepts_alias_map(fn: ToolFn) -> bool:
    """True iff the tool's signature declares an `alias_map` kwarg.

    chunks_* / user_* tools take their own alias_map to mint envelope
    refs eagerly. Legacy tools don't — they go through the
    output-aliasing path below instead.
    """
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return "alias_map" in params


def build_aliased_tools(
    base: dict[str, ToolFn], aliases: TurnAliasMap,
) -> dict[str, ToolFn]:
    """Wrap every tool that needs the per-turn alias map.

    For chunks_* / user_* tools (signature accepts `alias_map`) — inject
    it via closure; they handle envelope shaping themselves.

    For track-shaped tools — see the frozensets above for the canonical
    names — output-alias `track_id → ref`, input-dealias `ref → track_id`.

    Tools matching neither pass through unchanged.
    """

    legacy_relevant = (
        _TRACK_LIST_TOOLS
        | _TRACK_SINGLE_TOOLS
        | _ACCEPTS_TRACK_REFS.keys()
        | _ACCEPTS_TRACK_REF_SINGLE.keys()
    )

    def _make_envelope_wrapper(fn: ToolFn) -> ToolFn:
        async def _wrapped(**kwargs: Any) -> Any:
            kwargs.setdefault("alias_map", aliases)
            return await fn(**kwargs)
        return _wrapped

    def _make_legacy_wrapper(name: str, fn: ToolFn) -> ToolFn:
        async def _wrapped(**kwargs: Any) -> Any:
            real_kwargs = _dealias_args(name, kwargs, aliases)
            raw = await fn(**real_kwargs)
            return _alias_result(name, raw, aliases)
        return _wrapped

    out = dict(base)
    for name, fn in base.items():
        if _accepts_alias_map(fn):
            out[name] = _make_envelope_wrapper(fn)
        elif name in legacy_relevant:
            out[name] = _make_legacy_wrapper(name, fn)
    return out
