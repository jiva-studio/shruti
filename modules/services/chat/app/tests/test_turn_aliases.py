"""Unit tests for `TurnAliasMap` random-allocation refs.

The map mints integer aliases the LLM uses in `[cite:N|...]` / `[verse:N|...]`
markers. Allocation is non-sequential (random in [1, 9999]) to defeat
"predict-next-N" hallucinations.
"""

from __future__ import annotations

import random

from lectorium_chat.agent.turn_aliases import (
    ChunkRef,
    TurnAliasMap,
    VerseRef,
    _REF_MAX,
    _REF_MIN,
)


def test_alloc_within_range() -> None:
    m = TurnAliasMap()
    for _ in range(50):
        n = m.alias_chunk("track_x", 0, 1000)
        assert _REF_MIN <= n <= _REF_MAX


def test_alloc_unique_per_turn() -> None:
    m = TurnAliasMap()
    seen: set[int] = set()
    for i in range(200):
        n = m.alias_chunk(f"track_{i}", 0, 1000)
        assert n not in seen
        seen.add(n)


def test_alloc_non_sequential() -> None:
    """Three consecutive refs should not all be a sequential run."""
    random.seed(42)
    m = TurnAliasMap()
    refs = [m.alias_track(f"track_{i}") for i in range(10)]
    # At least one gap or out-of-order pair — otherwise allocation is suspect.
    is_strict_run = all(refs[i] + 1 == refs[i + 1] for i in range(len(refs) - 1))
    assert not is_strict_run, f"unexpectedly sequential: {refs}"


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


def test_lookup_ref_after_random_alloc() -> None:
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
