"""Version-segment composition and bumping."""

from __future__ import annotations

from shruti_chat.application import cache_versions as v


def setup_function():
    # Reset module-level state between tests.
    for k in ("catalog", "library", "embed_model", "llm"):
        v.set_tag(k, "0")


def test_namespace_composes_from_deps():
    v.set_tag("catalog", "20260520")
    v.set_tag("library", "20260518")
    assert v.cache_version_for("track_meta") == "20260520"
    assert v.cache_version_for("pg_lib_search").endswith("-20260518")


def test_bump_changes_value():
    before = v.cache_version_for("router")
    v.bump("llm")
    after = v.cache_version_for("router")
    assert before != after


def test_unknown_namespace_returns_zero():
    assert v.cache_version_for("not_a_real_ns") == "0"


def test_snapshot_returns_copy():
    snap = v.snapshot()
    snap["catalog"] = "tampered"
    assert v.snapshot()["catalog"] != "tampered"
