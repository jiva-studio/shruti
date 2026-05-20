"""Conditional edges for the chat graph.

Centralised routing matrix:

  direct_chat / unknown  → synthesizer        (no tools)
  help                   → help_worker        → synthesizer
  find_track             → catalog_worker     → synthesizer
  research               → research_worker    → synthesizer
  create_action          → research_worker    → action_worker → synthesizer

The action chain (research → action) is wired as static edges in
`builder.py`; this module only decides the FIRST hop out of the router.
"""

from __future__ import annotations

from shruti_chat.agent.graph.state import ChatState


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
        # Pre-action hop. If the router extracted catalog hints
        # (location/year/author/…) → catalog_worker; otherwise the
        # query is topic-based → research_worker. Either path chains
        # into action_worker.
        return "catalog_worker" if _has_catalog_hint(state) else "research_worker"
    if intent == "research":
        return "research_worker"
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
