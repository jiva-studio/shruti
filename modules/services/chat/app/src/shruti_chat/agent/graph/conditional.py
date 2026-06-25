"""Conditional edges for the chat graph.

Centralised routing matrix:

  direct_chat            → synthesizer        (no tools)
  unknown / default      → research_worker    → synthesizer  (light grounding, #39)
  help                   → help_worker        → synthesizer
  find_track             → find_tracks_worker → END  (semantic + metadata, no synth)
                        OR catalog_worker     → synthesizer  (history_ref only)
  recommend              → recommend_worker   → synthesizer      (no LLM loop)
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

A deictic «перескажи текущую лекцию» (research + `current_ref` with the
`current_track_ref` anchor set) is likewise routed to catalog_worker, which
carries the anchor + `track_outline_get` and recaps the open lecture —
research_worker is code-driven and never sees the anchor (#4).
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


def _is_history_ref(state: ChatState) -> bool:
    """True when the user asks for their own listening history by TIME
    WINDOW — «что я слушал на этой неделе / вчера», "what I listened to this
    week". The router sets the `history_ref` flag in `extracted_args`.

    This is a PERSONAL query over `user_context` (resolved by the catalog
    worker's `user_tracks_list(since=…, until=…)`), NOT a corpus search.
    Routing it to the semantic `find_tracks_worker` would blind-search the
    corpus for the phrase "что я слушал" and return junk — the user's own
    listen-log is not in the corpus index.
    """
    args = state.get("extracted_args") or {}
    return bool(args.get("history_ref"))


def _is_current_ref(state: ChatState) -> bool:
    """True when the user deictically points at the lecture they are
    CURRENTLY playing — «перескажи / о чём эта / текущая лекция»,
    "summarize this / the current lecture". The router sets the
    `current_ref` flag in `extracted_args` for these.

    Unlike `recent_ref`, the concrete track is already in scope as the
    `current_track_ref` anchor (minted from `user_context.current_track_id`).
    The catalog worker carries that anchor (anchor_block) AND
    `track_outline_get`, so it can pull the open lecture's outline and recap
    it. Routing this to research_worker is the #4 bug: research_worker is
    code-driven (run_research) and never sees the anchor, so it blind-
    searches the corpus and refuses with "no materials found".
    """
    args = state.get("extracted_args") or {}
    return bool(args.get("current_ref"))


def route_after_router(state: ChatState) -> str:
    """Pick the first worker node based on `state["intent"]`.

    `direct_chat` (greetings / meta-talk) goes straight to the tool-less
    `synthesizer` — there is nothing to ground. `unknown` (and any
    unrecognised intent) instead falls through a LIGHT research pass: a
    single misclassification by the router shouldn't yield a confident,
    tool-less "not found". The research_worker either grounds the answer
    or honestly comes up empty, and the synthesizer then phrases the
    result — which is strictly better than refusing with zero search.
    See #36 (the router no longer collapses retrieval-bearing intents to
    `unknown`, so what reaches here as `unknown` is genuinely ambiguous
    and most safely handled by attempting retrieval).
    """
    intent = state.get("intent", "unknown")
    if intent == "direct_chat":
        return "synthesizer"
    if intent == "help":
        return "help_worker"
    if intent == "find_track":
        # Listening history by time window («что я слушал на этой неделе») is a
        # PERSONAL query over user_context (user_tracks_list), not a corpus
        # search — keep it on the catalog worker so it isn't broken by the
        # semantic worker. Deictic personal recap («перескажи последнюю/текущую»)
        # is `research` (recent_ref/current_ref), handled in that branch below.
        if _is_history_ref(state):
            return "catalog_worker"
        # Otherwise: one worker, two search directions — semantic (topic) +
        # metadata filters — returning lecture cards each with a verbatim
        # why-quote.
        return "find_tracks_worker"
    if intent == "recommend":
        # Deterministic topic-affinity recommender — no LLM ReAct loop.
        return "recommend_worker"
    if intent == "show_verse":
        return "show_verse_worker"
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
        # A named scripture reference or metadata anchor («pdf лекции по
        # БГ 4.18», «pdf утренних прогулок 1976 Бомбей») is a concrete
        # corpus target. Gather those lectures by reference FIRST so the
        # action_worker — which has no search tools of its own — receives
        # real track_ids. This must win over `recent_ref`: a spurious
        # recent_ref (e.g. a follow-up «pdf, который вы обещали») would
        # otherwise shortcut to an empty listening-history lookup and the
        # PDF card would have nothing to render.
        if _has_catalog_hint(state):
            return "catalog_worker"
        # «сделай PDF последней лекции» — no named anchor, just a deictic
        # pointer at the user's own history; the action worker resolves it
        # itself via user_tracks_list. Routing this to research_worker is
        # the #46 bug: it semantic-searches for "the last lecture" and
        # returns junk cards.
        if _is_recent_ref(state):
            return "action_worker"
        # Topic-only PDF («pdf про карму») → semantic gather.
        return "research_worker"
    if intent == "research":
        # «перескажи последнюю / прошлую лекцию» — a deictic reference to
        # the user's own history, not a corpus topic. Only the catalog
        # worker can resolve it (user_tracks_list → track_outline_get);
        # research_worker would blind-search the corpus and refuse.
        if _is_recent_ref(state):
            return "catalog_worker"
        # «перескажи текущую лекцию» — the user points at the lecture they
        # are playing right now. The concrete track is already the
        # `current_track_ref` anchor; the catalog worker carries it (via
        # anchor_block) and `track_outline_get`, so it recaps the open
        # lecture. research_worker (code-driven run_research) never sees the
        # anchor and would refuse with an empty-corpus message (#4). Guard on
        # the anchor actually being present so a generic research query that
        # merely happens to mention "this" can't hijack a real corpus search.
        if _is_current_ref(state) and _has_track_anchor(state):
            return "catalog_worker"
        return "research_worker"
    if intent == "locate":
        return "locate_worker"
    # `unknown` / any unrecognised intent: attempt a light research pass
    # rather than answering tool-less. research_worker → synthesis_planner
    # → synthesizer grounds the reply when the corpus has something, and
    # falls back to an honest empty answer otherwise — never a confident
    # refusal with retrieval skipped (#39).
    return "research_worker"


def route_after_research(state: ChatState) -> str:
    """After research_worker: branch to action_worker on
    `create_action`, otherwise straight to synthesizer.
    """
    if state.get("intent") == "create_action":
        return "action_worker"
    return "synthesizer"


def route_after_planner(state: ChatState) -> str:
    """After synthesis_planner: branch into the out-of-corpus memory-pass
    fallback when the planner flagged `corpus_insufficient` (the corpus had
    nothing relevant — empty retrieval or every note rejected). Otherwise go
    straight to the synthesizer, which writes plan-driven prose, or — when the
    flag is unset because the fallback is disabled — the canned refusal.
    """
    if state.get("corpus_insufficient"):
        return "corpus_fallback"
    return "synthesizer"


def route_after_catalog(state: ChatState) -> str:
    """After catalog_worker: branch to action_worker on
    `create_action`, otherwise straight to synthesizer.
    """
    if state.get("intent") == "create_action":
        return "action_worker"
    return "synthesizer"


# Action results the action_worker appends to tool_results — each carries a
# `kind` matching its `[action:<kind>|id=…]` marker + a hex `action_id`.
_ACTION_RESULT_KINDS = frozenset({
    "share_pdf",
    "enable_daily_reminder",
    "configure_smart_library",
    "upgrade_to_pro",
})


def _produced_action_card(state: ChatState) -> bool:
    """True when the action_worker emitted an action card this turn (a
    tool_result with an action `kind` + `action_id`)."""
    for note in state.get("tool_results") or []:
        if (
            isinstance(note, dict)
            and isinstance(note.get("action_id"), str)
            and note.get("kind") in _ACTION_RESULT_KINDS
        ):
            return True
    return False


def route_after_action(state: ChatState) -> str:
    """After action_worker. A produced card IS the answer — emit it
    deterministically (just the `[action:…|id=…]` marker) and skip the LLM
    synthesizer: there's nothing to reason about, and the synthesizer only
    adds variable prose / stray `[card:…]` citations on what should be a flat
    list. When NO card was produced (nothing found / tool error), fall through
    to the synthesizer, which writes the «не нашёл …» message IN THE USER'S
    LANGUAGE — the one part that genuinely needs an LLM."""
    return "action_responder" if _produced_action_card(state) else "synthesizer"
