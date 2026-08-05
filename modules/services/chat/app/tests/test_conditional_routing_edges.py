"""The three edges nothing tested.

`route_after_router` has thirty tests. The four edges AFTER it had between
zero and three, and three of them had none at all — including the one that
carries «pdf утренних прогулок 1976 Бомбей»: the router sends that turn to the
catalog worker through a tested edge, and it leaves through an untested one.
An edge that returns the wrong node produces a turn that quietly does nothing,
which is exactly the failure this file exists to catch.

Also pinned here: the mapping in `builder.py`. A conditional edge's return
value is a KEY in a dict passed to `add_conditional_edges`, so a rename that
misses the map is a KeyError at runtime on that path only — never at import,
never in any test that doesn't take the path.
"""

from __future__ import annotations

from typing import get_args

import pytest
from langgraph.graph import END

from shruti_chat.agent.graph.conditional import (
    route_after_action,
    route_after_catalog,
    route_after_find_tracks,
    route_after_planner,
    route_after_research,
    route_after_router,
)
from shruti_chat.domain.routing import Intent


# ── research_worker → ? ───────────────────────────────────────────────────


def test_a_gathered_action_chains_into_the_action_worker() -> None:
    # «pdf про карму»: research gathered the lectures, the action worker turns
    # them into a card. This is the whole reason the chain exists.
    assert route_after_research({"intent": "create_action"}) == "action_worker"


@pytest.mark.parametrize("intent", ["research", "unknown", "locate"])
def test_everything_else_goes_on_to_be_written_up(intent: str) -> None:
    assert route_after_research({"intent": intent}) == "synthesizer"


def test_a_stateless_turn_still_routes() -> None:
    assert route_after_research({}) == "synthesizer"


# ── catalog_worker → ? ────────────────────────────────────────────────────


def test_a_metadata_action_chains_into_the_action_worker() -> None:
    # «pdf утренних прогулок 1976 Бомбей» — the catalog worker resolved the
    # tracks; without this edge the PDF is never built and the turn just talks.
    assert route_after_catalog({"intent": "create_action"}) == "action_worker"


def test_a_catalog_listing_goes_straight_to_the_answer() -> None:
    assert route_after_catalog({"intent": "find_track"}) == "synthesizer"


# ── find_tracks_worker → ? ────────────────────────────────────────────────


def test_a_corpus_miss_offers_to_fetch_from_the_web() -> None:
    assert route_after_find_tracks({"web_fallback": True}) == "add_to_library_worker"


@pytest.mark.parametrize("state", [{}, {"web_fallback": False}])
def test_lecture_cards_are_the_end_of_the_turn(state: dict) -> None:
    # The worker already streamed its cards and headers; a synthesizer pass
    # here would re-narrate a finished list.
    assert route_after_find_tracks(state) == END


# ── the map in builder.py ─────────────────────────────────────────────────


def _edge_maps() -> dict[str, set[str]]:
    """`{source_node: {mapped return values}}` as builder.py declares them."""
    import ast
    import inspect

    from shruti_chat.agent.graph import builder

    tree = ast.parse(inspect.getsource(builder))
    out: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Call)
            and getattr(node.func, "attr", "") == "add_conditional_edges"
        ):
            continue
        source = node.args[0].value
        mapping = node.args[2]
        keys = set()
        for k in mapping.keys:
            keys.add(k.value if isinstance(k, ast.Constant) else "END")
        out[source] = keys
    return out


@pytest.mark.parametrize(
    ("fn", "source", "inputs"),
    [
        (route_after_research, "research_worker", [{"intent": i} for i in get_args(Intent)]),
        (route_after_catalog, "catalog_worker", [{"intent": i} for i in get_args(Intent)]),
        (
            route_after_find_tracks,
            "find_tracks_worker",
            [{}, {"web_fallback": True}],
        ),
        (
            route_after_planner,
            "synthesis_planner",
            [{}, {"corpus_insufficient": True}],
        ),
        (
            route_after_action,
            "action_worker",
            [
                {},
                {"tool_results": [{"kind": "share_pdf", "action_id": "a1"}]},
            ],
        ),
    ],
)
def test_every_reachable_return_value_has_an_edge(fn, source, inputs) -> None:
    mapped = _edge_maps()[source]
    for state in inputs:
        got = fn(state)
        key = "END" if got is END else got
        assert key in mapped, f"{source} can return {key!r}, which builder.py never maps"


def test_the_router_edge_maps_every_intent() -> None:
    """Including a value that is in the enum but not in the routing function —
    it falls to the default arm, and the default arm must also be mapped."""
    mapped = _edge_maps()["router"]
    for intent in get_args(Intent):
        assert route_after_router({"intent": intent}) in mapped


def test_an_intent_string_nobody_recognises_still_lands_somewhere() -> None:
    # A retired or misspelled value must degrade to a search, not crash the turn.
    assert route_after_router({"intent": "flibbertigibbet"}) == "research_worker"
    assert route_after_router({}) == "research_worker"
