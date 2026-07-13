"""Tests for `agent/graph/conditional.py` — the routing matrix that
maps `state["intent"]` to the next worker node.

Covers the short-path added on top of the original behavior:

- `create_action` + `action_kind` in {reminder, smart_library, pro}
  skips research/catalog entirely.
- `create_action` + `current_track_ref` (or `focus_ref`) skips
  research/catalog entirely — the track is already known.
- `create_action` + PDF + no anchor still uses the original gather
  path: catalog_worker when there are catalog hints, research_worker
  otherwise.
"""

from __future__ import annotations

from lectorium_chat.agent.graph.conditional import (
    route_after_action,
    route_after_planner,
    route_after_router,
)


def test_direct_chat_goes_to_synthesizer() -> None:
    assert route_after_router({"intent": "direct_chat"}) == "synthesizer"


# ── route_after_planner: corpus-insufficient → memory-pass fallback ──


def test_planner_insufficient_routes_to_corpus_fallback() -> None:
    assert route_after_planner({"corpus_insufficient": True}) == "corpus_fallback"


def test_planner_sufficient_routes_to_synthesizer() -> None:
    assert route_after_planner({"corpus_insufficient": False}) == "synthesizer"


def test_planner_unset_flag_routes_to_synthesizer() -> None:
    # Disabled fallback / a normal plan never sets the flag → straight to synth
    # (which then writes plan-driven prose or the canned refusal).
    assert route_after_planner({}) == "synthesizer"


# ── route_after_action: card → deterministic responder, else synth ──


def test_action_with_card_goes_to_deterministic_responder() -> None:
    """A produced action card IS the answer — emit it deterministically
    (the marker), skip the LLM synthesizer."""
    state = {
        "tool_results": [
            {"kind": "share_pdf", "action_id": "abc123", "items": [{}]},
        ],
    }
    assert route_after_action(state) == "action_responder"


def test_action_reminder_card_goes_to_deterministic_responder() -> None:
    state = {"tool_results": [{"kind": "enable_daily_reminder", "action_id": "ee55"}]}
    assert route_after_action(state) == "action_responder"


def test_action_without_card_goes_to_synthesizer() -> None:
    """Nothing found / tool error → no card → the synthesizer writes the
    localized «не нашёл …» message (needs an LLM for the language)."""
    assert route_after_action({"tool_results": [{"error": "no_pdfs_prepared"}]}) == "synthesizer"
    assert route_after_action({"tool_results": []}) == "synthesizer"
    assert route_after_action({}) == "synthesizer"


def test_help_goes_to_help_worker() -> None:
    assert route_after_router({"intent": "help"}) == "help_worker"


def test_find_track_goes_to_find_tracks_worker() -> None:
    # find_track now means "search for the lectures themselves" (semantic +
    # metadata) → the deterministic find_tracks_worker, not catalog_worker.
    assert route_after_router({"intent": "find_track"}) == "find_tracks_worker"


def test_find_track_history_ref_stays_on_catalog_worker() -> None:
    # Listening history by time window («что я слушал на этой неделе») is a
    # personal user_tracks_list query, not a corpus search — it must NOT reach
    # the semantic worker, which would return junk. WITH a listen-log present it
    # goes to the catalog worker.
    assert (
        route_after_router({
            "intent": "find_track",
            "extracted_args": {"history_ref": True},
            "history_summary": "recent=5 in_progress=2",
        })
        == "catalog_worker"
    )


def test_find_track_history_ref_without_history_asks() -> None:
    # Same query but NO listen-log (client didn't send recent_tracks / sync off)
    # → the catalog worker would deflect with "nothing found"; ask instead.
    assert (
        route_after_router({"intent": "find_track", "extracted_args": {"history_ref": True}})
        == "clarify_worker"
    )


def test_research_goes_to_research_worker() -> None:
    assert route_after_router({"intent": "research"}) == "research_worker"


def test_unknown_routes_through_light_research() -> None:
    # #39: `unknown` no longer drops to a tool-less synthesizer reply.
    # It runs a light research pass so a single misclassification can't
    # yield a confident "not found" with retrieval skipped — the worker
    # grounds the answer or honestly comes up empty.
    assert route_after_router({"intent": "unknown"}) == "research_worker"


def test_missing_intent_routes_through_light_research() -> None:
    # The default (unrecognised / missing intent) takes the same light
    # research path as `unknown` (#39).
    assert route_after_router({}) == "research_worker"


def test_direct_chat_stays_tool_less() -> None:
    # direct_chat (greetings / meta-talk) has nothing to ground and still
    # goes straight to the tool-less synthesizer.
    assert route_after_router({"intent": "direct_chat"}) == "synthesizer"


# ── create_action short paths ──────────────────────────────────────


def test_create_action_reminder_skips_search() -> None:
    """Reminders don't need tracks — go straight to action_worker."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "reminder"},
    }
    assert route_after_router(state) == "action_worker"


def test_create_action_smart_library_skips_search() -> None:
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "smart_library"},
    }
    assert route_after_router(state) == "action_worker"


def test_create_action_pro_skips_search() -> None:
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pro"},
    }
    assert route_after_router(state) == "action_worker"


def test_create_action_pdf_with_current_track_skips_search() -> None:
    """User on an open lecture says «сделай pdf этой лекции» —
    the track is already known, no need to gather candidates."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pdf"},
        "current_track_ref": 1,
    }
    assert route_after_router(state) == "action_worker"


def test_create_action_pdf_with_focus_ref_skips_search() -> None:
    """User pointed at a citation chip — same idea."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pdf"},
        "focus_ref": 3,
    }
    assert route_after_router(state) == "action_worker"


# ── create_action gather paths (regression guard) ─────────────────


def test_create_action_pdf_no_anchor_no_hints_goes_to_research() -> None:
    """«сделай pdf про карму» — topic only, need semantic gather."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pdf"},
    }
    assert route_after_router(state) == "research_worker"


def test_create_action_pdf_no_anchor_with_catalog_hints_goes_to_catalog() -> None:
    """«pdf утренних прогулок 1976 Бомбей» — metadata-anchored gather."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pdf", "year": 1976, "location": "Bombay"},
    }
    assert route_after_router(state) == "catalog_worker"


def test_create_action_without_action_kind_legacy_path() -> None:
    """Router didn't extract `action_kind` (e.g. older fixtures): keep
    the original behavior — research_worker fallback."""
    state = {
        "intent": "create_action",
        "extracted_args": {},
    }
    assert route_after_router(state) == "research_worker"


def test_create_action_track_anchor_overrides_catalog_hint() -> None:
    """Even with catalog hints, an in-context track wins — we don't
    re-search a lecture the user is already looking at."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pdf", "year": 1976},
        "current_track_ref": 7,
    }
    assert route_after_router(state) == "action_worker"


# ── deictic "last / previous lecture" (recent_ref) — #44 / #46 ─────


def test_research_recent_ref_goes_to_catalog_worker() -> None:
    """«перескажи последнюю лекцию» — research intent + recent_ref must
    go to the catalog worker (user_tracks_list → track_outline_get),
    NOT research_worker (which would blind-search the corpus and refuse) —
    when there IS a listen-log to resolve against."""
    state = {
        "intent": "research",
        "extracted_args": {"recent_ref": True},
        "history_summary": "recent=3 in_progress=1",
    }
    assert route_after_router(state) == "catalog_worker"


def test_research_recent_ref_without_history_asks() -> None:
    """recent_ref but no listen-log → ask which lecture instead of deflecting."""
    state = {"intent": "research", "extracted_args": {"recent_ref": True}}
    assert route_after_router(state) == "clarify_worker"


def test_research_without_recent_ref_stays_research() -> None:
    """A normal research query without the deictic flag is unchanged."""
    state = {
        "intent": "research",
        "extracted_args": {},
    }
    assert route_after_router(state) == "research_worker"


def test_create_action_pdf_recent_ref_goes_to_action_worker() -> None:
    """«сделай PDF последней лекции» — no anchor, but recent_ref means the
    action worker resolves the last track itself via user_tracks_list, so
    skip the pre-action search instead of misrouting to research_worker —
    when there IS a listen-log to resolve against."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pdf", "recent_ref": True},
        "history_summary": "recent=4 in_progress=1",
    }
    assert route_after_router(state) == "action_worker"


def test_create_action_pdf_recent_ref_without_history_asks() -> None:
    """PDF of "last lecture" with no listen-log → user_tracks_list yields
    nothing and the PDF card can't render; ask which lecture instead."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pdf", "recent_ref": True},
    }
    assert route_after_router(state) == "clarify_worker"


def test_create_action_pdf_recent_ref_anchor_still_short_path() -> None:
    """A current_track_ref still wins (and also short-paths) — recent_ref
    doesn't change that the action worker has what it needs."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pdf", "recent_ref": True},
        "current_track_ref": 4,
    }
    assert route_after_router(state) == "action_worker"


def test_create_action_pdf_catalog_hint_beats_recent_ref() -> None:
    """«pdf транскрипции лекции по БГ 4.18» where a follow-up rewrite also
    (spuriously) set recent_ref. A named scripture reference is a concrete
    corpus target, so gather those lectures by reference via catalog_worker
    rather than short-pathing to an empty listening-history lookup. The
    action_worker has no search tools of its own — without this it would
    call track_pdf_generate with no track_ids and the PDF card would be
    empty (the «и где файл?» bug)."""
    state = {
        "intent": "create_action",
        "extracted_args": {
            "action_kind": "pdf",
            "source_id": "BG",
            "tokens": "4.18",
            "recent_ref": True,
        },
    }
    assert route_after_router(state) == "catalog_worker"


# ── deictic "this / current lecture" (current_ref) — #4 ────────────


def test_research_current_ref_with_anchor_goes_to_catalog_worker() -> None:
    """«перескажи текущую лекцию» — research intent + current_ref with the
    current_track_ref anchor set must go to the catalog worker (it carries
    the anchor + track_outline_get), NOT research_worker (code-driven
    run_research never sees the anchor and refuses with empty corpus)."""
    state = {
        "intent": "research",
        "extracted_args": {"current_ref": True},
        "current_track_ref": 12,
    }
    assert route_after_router(state) == "catalog_worker"


def test_research_current_ref_without_anchor_stays_research() -> None:
    """current_ref but NO anchor (e.g. nothing playing) — there's no track
    to recap, so fall through to research rather than send the catalog
    worker on an empty hunt."""
    state = {
        "intent": "research",
        "extracted_args": {"current_ref": True},
    }
    assert route_after_router(state) == "research_worker"


def test_research_anchor_without_current_ref_stays_research() -> None:
    """A generic research query that merely happens to have a lecture open
    (current_track_ref set) but is NOT about "this lecture" (no current_ref)
    must still do a real corpus search."""
    state = {
        "intent": "research",
        "extracted_args": {},
        "current_track_ref": 12,
    }
    assert route_after_router(state) == "research_worker"
