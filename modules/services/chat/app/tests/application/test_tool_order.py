"""Per-worker tool menus must be ordered by declaration, not by hash.

`_subset` builds each worker's tool dict, and `tool_schemas_from` reads that
dict to order the schema list sent to the model. When the name collections
were frozensets, that order followed set iteration — which for strings varies
with PYTHONHASHSEED, so the menu reshuffled between process restarts. Tool
order measurably moves selection on weak models, which is the whole reason
the bag is split per worker in the first place.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.graph.nodes._worker_common import tool_schemas_from
from shruti_chat.application.chat_turn import (
    _ACTION_TOOL_NAMES,
    _CATALOG_TOOL_NAMES,
    _HELP_TOOL_NAMES,
    _LOCATE_TOOL_NAMES,
    _RESEARCH_TOOL_NAMES,
    _subset,
)


_ALL_SUBSETS = (
    _RESEARCH_TOOL_NAMES,
    _LOCATE_TOOL_NAMES,
    _CATALOG_TOOL_NAMES,
    _ACTION_TOOL_NAMES,
    _HELP_TOOL_NAMES,
)


def test_subsets_are_ordered_collections() -> None:
    # A set here reintroduces the PYTHONHASHSEED dependency silently — the
    # code still works, the menu just stops being stable.
    for names in _ALL_SUBSETS:
        assert isinstance(names, tuple), names


def test_subset_preserves_declaration_order() -> None:
    bag: dict[str, Any] = {n: object() for n in _RESEARCH_TOOL_NAMES}
    assert list(_subset(bag, _RESEARCH_TOOL_NAMES)) == list(_RESEARCH_TOOL_NAMES)


def test_subset_drops_unbound_names_without_reordering() -> None:
    dropped = _RESEARCH_TOOL_NAMES[2]
    bag: dict[str, Any] = {
        n: object() for n in _RESEARCH_TOOL_NAMES if n != dropped
    }
    picked = list(_subset(bag, _RESEARCH_TOOL_NAMES))

    assert dropped not in picked
    assert picked == [n for n in _RESEARCH_TOOL_NAMES if n != dropped]


def test_schema_list_follows_the_declared_menu_order() -> None:
    import shruti_chat.agent.tools  # noqa: F401 — populates the registry

    bag: dict[str, Any] = {n: object() for n in _CATALOG_TOOL_NAMES}
    schemas = tool_schemas_from(_subset(bag, _CATALOG_TOOL_NAMES))
    names = [s["function"]["name"] for s in schemas]

    assert names == [n for n in _CATALOG_TOOL_NAMES if n in set(names)]
    assert names, "expected the catalog tools to be registered"
