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

from shruti_chat.agent.graph.conditional import (
    route_after_router,
)


def test_direct_chat_goes_to_synthesizer() -> None:
    assert route_after_router({"intent": "direct_chat"}) == "synthesizer"


def test_help_goes_to_help_worker() -> None:
    assert route_after_router({"intent": "help"}) == "help_worker"


def test_find_track_goes_to_catalog_worker() -> None:
    assert route_after_router({"intent": "find_track"}) == "catalog_worker"


def test_research_goes_to_research_worker() -> None:
    assert route_after_router({"intent": "research"}) == "research_worker"


def test_unknown_falls_back_to_synthesizer() -> None:
    assert route_after_router({"intent": "unknown"}) == "synthesizer"


def test_missing_intent_falls_back_to_synthesizer() -> None:
    assert route_after_router({}) == "synthesizer"


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
    NOT research_worker (which would blind-search the corpus and refuse)."""
    state = {
        "intent": "research",
        "extracted_args": {"recent_ref": True},
    }
    assert route_after_router(state) == "catalog_worker"


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
    skip the pre-action search instead of misrouting to research_worker."""
    state = {
        "intent": "create_action",
        "extracted_args": {"action_kind": "pdf", "recent_ref": True},
    }
    assert route_after_router(state) == "action_worker"


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
