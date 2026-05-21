"""Unit tests for `TurnAliasMap` sequential-allocation refs.

The map mints small sequential integer aliases the LLM uses in
`[ref:N]` markers. Sequential keeps the integers 1-2 digits so small
models can copy them verbatim across long output streams (random
1-9999 alloc drove Flash-Lite to invent plausible-looking 4-digit
refs by analogy mid-reply).
"""

from __future__ import annotations

from lectorium_chat.agent.turn_aliases import (
    ChunkRef,
    TurnAliasMap,
    VerseRef,
)


def test_alloc_starts_at_one() -> None:
    m = TurnAliasMap()
    assert m.alias_chunk("track_x", 0, 1000) == 1
    assert m.alias_chunk("track_y", 0, 1000) == 2
    assert m.alias_track("track_z") == 3
    assert m.alias_verse("BG", "2.13") == 4


def test_alloc_unique_per_turn() -> None:
    m = TurnAliasMap()
    seen: set[int] = set()
    for i in range(200):
        n = m.alias_chunk(f"track_{i}", 0, 1000)
        assert n not in seen
        seen.add(n)


def test_alloc_strictly_sequential() -> None:
    """Sequential allocation: each call gives previous+1.

    The earlier random allocation drove a small model to invent fake
    4-digit refs (`[ref:1022]`) because the real integer fell out of
    working memory. Sequential 1-2 digit aliases are dramatically
    easier to copy verbatim.
    """
    m = TurnAliasMap()
    refs = [m.alias_track(f"track_{i}") for i in range(5)]
    assert refs == [1, 2, 3, 4, 5]


def test_known_keys_returns_all_minted() -> None:
    """`known_keys` powers the marker_expander recovery path —
    `(known - emitted)` reveals the lone unused alias on a miss."""
    m = TurnAliasMap()
    m.alias_chunk("track_a", 0, 100)
    m.alias_verse("BG", "2.13")
    m.alias_track("track_b")
    assert m.known_keys() == {1, 2, 3}


def test_resolve_round_trip() -> None:
    m = TurnAliasMap()
    n_chunk = m.alias_chunk("track_a", 1000, 2000)
    n_track = m.alias_track("track_b")
    n_verse = m.alias_verse("BG", "2.13", addr_label="БГ 2.13")
    assert m.resolve(n_chunk) == ChunkRef(track_id="track_a", start_ms=1000, end_ms=2000)
    assert m.resolve(n_track) == ChunkRef(track_id="track_b")
    assert m.resolve(n_verse) == VerseRef(source_id="BG", tokens="2.13", addr_label="БГ 2.13")
    assert m.resolve(9_999_999) is None


def test_serialize_load_round_trip() -> None:
    m = TurnAliasMap()
    m.alias_chunk("track_a", 100, 200)
    m.alias_track("track_b")
    m.alias_verse("BG", "2.13")
    blob = m.serialize()

    m2 = TurnAliasMap()
    m2.load_external(blob)
    # Same refs resolve to equivalent entries.
    for k_str, _ in blob.items():
        n = int(k_str)
        assert m2.resolve(n) is not None
    # Loaded refs reserved → next allocation does NOT collide.
    fresh = m2.alias_track("track_c")
    assert fresh not in {int(k) for k in blob}


def test_load_external_reserves_refs() -> None:
    """A ref loaded from history must never be re-issued in the same turn."""
    m = TurnAliasMap()
    m.load_external({"42": {"track_id": "old", "start_ms": 0, "end_ms": 1000}})
    for _ in range(200):
        n = m.alias_chunk("new", 0, 100)
        assert n != 42


def test_lookup_ref_finds_minted_alias() -> None:
    m = TurnAliasMap()
    n = m.alias_chunk("track_x", 1000, 2000)
    assert m.lookup_ref("track_x", 1000, 2000) == n
    assert m.lookup_ref("track_x", 0, 500) is None


def test_lookup_verse_ref() -> None:
    m = TurnAliasMap()
    n = m.alias_verse("BG", "2.13")
    assert m.lookup_verse_ref("BG", "2.13") == n
    assert m.lookup_verse_ref("SB", "1.1.1") is None


def test_dealias_many_filters_verse_and_unknown() -> None:
    m = TurnAliasMap()
    n_track = m.alias_track("real")
    n_verse = m.alias_verse("BG", "2.13")
    out = m.dealias_many([n_track, n_verse, 9_999_999])
    assert out == ["real"]


def test_contains() -> None:
    m = TurnAliasMap()
    n = m.alias_track("x")
    assert n in m
    assert (n + 10_000) not in m
