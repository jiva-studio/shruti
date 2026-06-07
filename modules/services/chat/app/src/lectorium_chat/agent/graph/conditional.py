"""Conditional edges for the chat graph.

Centralised routing matrix:

  direct_chat / unknown  → synthesizer        (no tools)
  help                   → help_worker        → synthesizer
  find_track             → catalog_worker     → synthesizer
  research               → research_worker    → synthesizer
  create_action          → action_worker      → synthesizer      (short path)
                        OR research_worker    → action_worker → synthesizer
                        OR catalog_worker     → action_worker → synthesizer

The action chain (research/catalog → action) is wired as static edges
in `builder.py`; this module only decides the FIRST hop out of the
router. The SHORT path skips the pre-action search entirely when:
- we already know the track (current_track_ref / focus_ref is set), or
- the action doesn't need tracks at all (reminder, smart_library, pro), or
- the user deictically points at their last-played lecture (recent_ref)
  — the action worker resolves it itself via user_tracks_list.

A deictic «перескажи / PDF последней лекции» (research / create_action +
`recent_ref`) is routed to the worker that can read the user's listening
history (catalog_worker for the recap, action_worker for the PDF) instead
of research_worker, which would blind-search the corpus and refuse.
"""

from __future__ import annotations

from lectorium_chat.agent.graph.state import ChatState


# Catalog-style hints in `extracted_args` mean the user named a
# concrete metadata anchor (location, author, source, year, kind).
# When these are present on a `create_action` intent we route the
# pre-action step through `catalog_worker` (which has tracks_list /
# *_resolve) instead of `research_worker` (which only has semantic
# search). Without this, "поставь утренние прогулки 1976 Бомбей в
# плейлист" goes through chunks_search instead of tracks_list and
# returns the wrong tracks.
_CATALOG_HINT_KEYS = (
    "author",
    "location",
    "source_id",
    "year",
    "date_from",
    "date_to",
    "doc_date_from",
    "doc_date_to",
    "kind",
)


def _has_catalog_hint(state: ChatState) -> bool:
    args = state.get("extracted_args") or {}
    return any(args.get(k) not in (None, "", []) for k in _CATALOG_HINT_KEYS)


# Actions that don't need any track candidates — they operate on
# user-level state (reminders, library config, paywall). Routing them
# through research/catalog first wastes a turn and pollutes the
# action_worker's context with irrelevant chunks.
_TRACK_FREE_ACTIONS = ("reminder", "smart_library", "pro")


def _has_track_anchor(state: ChatState) -> bool:
    """True when the user has a specific track/fragment in scope —
    either an open lecture (`current_track_ref`) or a focused citation
    (`focus_ref`). When that's the case, the action_worker already has
    everything it needs; a pre-action search would just rediscover the
    same track.
    """
    return bool(state.get("current_track_ref") or state.get("focus_ref"))


def _is_recent_ref(state: ChatState) -> bool:
    """True when the user deictically points at their own listening
    history WITHOUT naming a track — «последнюю / прошлую / недавнюю
    лекцию», "my last / previous lecture". The router sets the
    `recent_ref` flag in `extracted_args` for these.

    Such a request can ONLY be resolved against `user_context.recent_tracks`
    (via `user_tracks_list`), which lives on the catalog worker — NOT
    via blind corpus search. Routing it to research_worker is the #44/#46
    bug: it produces junk semantic-search cards and a corpus-not-found
    refusal because "the user's last-played lecture" is not a thing the
    corpus index knows about.
    """
    args = state.get("extracted_args") or {}
    return bool(args.get("recent_ref"))


def route_after_router(state: ChatState) -> str:
    """Pick the first worker node based on `state["intent"]`.

    Unknown intents fall back to `synthesizer` for a tool-less reply
    ("could you clarify?"). Same for direct_chat.
    """
    intent = state.get("intent", "unknown")
    if intent == "direct_chat":
        return "synthesizer"
    if intent == "help":
        return "help_worker"
    if intent == "find_track":
        return "catalog_worker"
    if intent == "create_action":
        args = state.get("extracted_args") or {}
        action_kind = args.get("action_kind")
        # Short path: skip pre-action search when there's nothing to
        # search for. Either the track is already anchored in context,
        # or the action doesn't need tracks at all.
        if action_kind in _TRACK_FREE_ACTIONS:
            return "action_worker"
        if _has_track_anchor(state):
            return "action_worker"
        # «сделай PDF последней лекции» — no current_track / focus, but
        # the user IS pointing at a concrete track: their last-played one.
        # The action worker resolves it itself via user_tracks_list (it
        # now carries that tool), so go straight there — no pre-action
        # search. Routing this to research_worker is the #46 bug: it
        # semantic-searches for "the last lecture" and returns junk cards.
        if _is_recent_ref(state):
            return "action_worker"
        # PDF without an anchor: we DO need to gather tracks first.
        # Catalog hints (author/source/date/…) → deterministic path;
        # otherwise the query is topic-based → semantic research.
        return "catalog_worker" if _has_catalog_hint(state) else "research_worker"
    if intent == "research":
        # «перескажи последнюю / прошлую лекцию» — a deictic reference to
        # the user's own history, not a corpus topic. Only the catalog
        # worker can resolve it (user_tracks_list → track_outline_get);
        # research_worker would blind-search the corpus and refuse.
        if _is_recent_ref(state):
            return "catalog_worker"
        return "research_worker"
    if intent == "locate":
        return "locate_worker"
    return "synthesizer"


def route_after_research(state: ChatState) -> str:
    """After research_worker: branch to action_worker on
    `create_action`, otherwise straight to synthesizer.
    """
    if state.get("intent") == "create_action":
        return "action_worker"
    return "synthesizer"


def route_after_catalog(state: ChatState) -> str:
    """After catalog_worker: branch to action_worker on
    `create_action`, otherwise straight to synthesizer.
    """
    if state.get("intent") == "create_action":
        return "action_worker"
    return "synthesizer"
