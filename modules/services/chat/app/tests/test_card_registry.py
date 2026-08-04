"""Structural guard for the auto-render card registry (`CARD_SPECS`).

These tests are the "you can't forget a card kind" net. The whole point of
the registry is that eager emission (`flush_card_payloads`), lazy synth-time
emission (`synthesizer._bridge_synth_events`), and translation (inside each
`build`) all derive from ONE list. A new card kind is one `CardSpec` entry;
these tests fail if it's half-wired:

  * removed/added to the registry but not the expander (or vice versa), or
  * an eager flush that translates the whole pool for a card client sneaks
    back in.
"""

from __future__ import annotations

import pytest

import shruti_chat.agent.graph.nodes._worker_common as wc
from shruti_chat.agent.graph.nodes._worker_common import (
    CARD_SPEC_BY_FAMILY,
    CARD_SPECS,
    flush_card_payloads,
)
from shruti_chat.agent.graph.turn_context import TurnContext
from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.turn_aliases import TurnAliasMap


_EXPECTED_FAMILIES = {"verse", "cite", "media", "chapter"}


@pytest.fixture
def capture_writer(monkeypatch):
    events: list[dict] = []
    monkeypatch.setattr(wc, "get_stream_writer", lambda: events.append)
    return events


def _alias_one_of_each(aliases: TurnAliasMap) -> dict[str, int]:
    return {
        "verse": aliases.alias_verse("src1", "1.1", addr_label="V 1.1"),
        "cite": aliases.alias_chunk("track1", 0, 1000, lang="en"),
        "media": aliases.alias_media("media1", label="M", text="english media"),
        "chapter": aliases.alias_chapter("src2", "7", "Canto 7", [("7.1", "english title")]),
    }


def test_registry_is_consistent():
    families = [s.family for s in CARD_SPECS]
    assert len(families) == len(set(families)), "duplicate family in CARD_SPECS"
    assert set(families) == set(CARD_SPEC_BY_FAMILY)
    assert set(families) == _EXPECTED_FAMILIES
    for spec in CARD_SPECS:
        assert spec.action_kind, "every CardSpec must ship an SSE action_kind"


async def test_expander_queued_families_match_registry():
    """Every family the expander queues for lazy emit has a CARD_SPECS entry
    (else the bridge KeyErrors), and all registered families are reachable —
    so adding/removing a card kind must touch BOTH the expander and the
    registry, or this fails."""
    aliases = TurnAliasMap()
    refs = _alias_one_of_each(aliases)
    e = MarkerExpander(aliases, lazy_cards=True)
    out = ""
    for n in refs.values():
        out += await e.feed(f"[^{n}] ")
    out += await e.flush()
    families = {req.family for req in e.take_card_requests()}
    assert families == set(CARD_SPEC_BY_FAMILY) == _EXPECTED_FAMILIES


async def test_card_client_eager_flush_translates_and_emits_nothing(capture_writer):
    """THE guard against the bug we kept hitting: for a card-capable client,
    the single eager `flush_card_payloads` must emit + translate NOTHING (all
    cards are lazy). One of every card kind is aliased; an exploding
    translator proves nothing is translated. A new kind is covered for free."""

    class _Boom:
        calls = 0

        async def translate(self, *args, **kwargs):
            type(self).calls += 1
            raise AssertionError("card-capable client translated a card eagerly")

    ctx = TurnContext(
        lang_code="uk",
        translate_citations=True,
        translator=_Boom(),
        capabilities={"commentary_card": True},
        library_db_path="/fake/library.db",
    )
    refs = _alias_one_of_each(ctx.aliases)
    ctx.aliases.chunk_texts[refs["cite"]] = "english transcript"

    await flush_card_payloads(ctx)

    assert capture_writer == []   # all cards lazy → eager flush emits nothing
    assert _Boom.calls == 0       # …and translates nothing
