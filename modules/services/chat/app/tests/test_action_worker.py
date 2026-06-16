"""Unit tests for the deterministic action node's track resolution.

The bug these guard: a «pdf по БГ 4.18» turn routed to create_action and
the catalog gather found the lectures, but the (old, LLM) action worker
called track_pdf_generate with no track_ids. The node is deterministic
now — `_resolve_pdf_track_refs` turns the gather/anchor/prior/recent
sources into integer refs the aliased tool de-aliases back to track_ids.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from lectorium_chat.agent.graph.nodes.action_worker import (
    _MAX_PDF_BATCH,
    _resolve_pdf_track_refs,
)
from lectorium_chat.agent.turn_aliases import TurnAliasMap


def _ctx(aliases: TurnAliasMap) -> SimpleNamespace:
    # _resolve_pdf_track_refs only touches ctx.aliases and ctx.action_tools.
    return SimpleNamespace(aliases=aliases, action_tools={})


@pytest.mark.asyncio
async def test_resolve_from_catalog_gather() -> None:
    """The real bug: catalog gather put lecture rows (each with an integer
    `ref`) in tool_results; the node must surface their track_ids."""
    aliases = TurnAliasMap()
    ref_a = aliases.alias_track("track_A")
    ref_b = aliases.alias_track("track_B")
    state = {
        "tool_results": [
            # tracks_list returns a LIST of rows, appended as ONE element —
            # the resolver must flatten it (the bug this guards).
            [
                {"ref": ref_a, "type": "lecture", "title": "БГ 4.18 lecture"},
                {"ref": ref_b, "type": "lecture", "title": "another"},
            ],
            # catalog_worker's spurious track_pdf_generate error (a bare dict).
            {"error": "tool_not_available"},
        ],
    }
    refs = await _resolve_pdf_track_refs(state, _ctx(aliases))
    assert aliases.dealias_many(refs) == ["track_A", "track_B"]


@pytest.mark.asyncio
async def test_anchor_wins_over_gather() -> None:
    aliases = TurnAliasMap()
    anchor = aliases.alias_track("track_OPEN")
    gather = aliases.alias_track("track_G")
    state = {
        "current_track_ref": anchor,
        "tool_results": [{"ref": gather, "type": "lecture"}],
    }
    refs = await _resolve_pdf_track_refs(state, _ctx(aliases))
    assert aliases.dealias_many(refs) == ["track_OPEN"]


@pytest.mark.asyncio
async def test_dedup_by_track_and_cap() -> None:
    """Many refs for the same track (e.g. research transcript chunks) collapse
    to one; the result is capped at _MAX_PDF_BATCH distinct tracks."""
    aliases = TurnAliasMap()
    # Two refs pointing at the SAME track + a bunch of distinct tracks.
    dup1 = aliases.alias_track("track_X")
    dup2 = aliases.alias_track("track_X")
    many = [aliases.alias_track(f"track_{i}") for i in range(_MAX_PDF_BATCH + 3)]
    state = {
        # one tracks_list element holding all the rows
        "tool_results": [[{"ref": r, "type": "lecture"} for r in (dup1, dup2, *many)]],
    }
    refs = await _resolve_pdf_track_refs(state, _ctx(aliases))
    ids = aliases.dealias_many(refs)
    assert ids[0] == "track_X"           # dup collapsed to one, first-seen
    assert len(ids) == _MAX_PDF_BATCH    # capped
    assert len(set(ids)) == len(ids)     # all distinct


@pytest.mark.asyncio
async def test_empty_when_nothing_resolvable() -> None:
    aliases = TurnAliasMap()
    refs = await _resolve_pdf_track_refs({"tool_results": []}, _ctx(aliases))
    assert refs == []


@pytest.mark.asyncio
async def test_verse_refs_are_skipped() -> None:
    """A turn that gathered only a verse/commentary (no track) yields no PDF
    candidates — those refs carry no track_id."""
    aliases = TurnAliasMap()
    aliases.alias_verse(source_id="source_BG", tokens="4.18", addr_label="БГ 4.18")
    # The verse note as it would sit in tool_results carries a `ref`, but it
    # de-aliases to no track.
    verse_ref = next(iter(dict(aliases.verse_refs()).keys()), None)
    state = {"tool_results": [{"ref": verse_ref, "type": "verse"}]} if verse_ref else {"tool_results": []}
    refs = await _resolve_pdf_track_refs(state, _ctx(aliases))
    assert refs == []
