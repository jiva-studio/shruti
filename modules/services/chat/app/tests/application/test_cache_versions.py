"""Version-segment composition over the process's tag registry."""

from __future__ import annotations

from shruti_chat.application.cache_versions import CacheVersionRegistry
from shruti_chat.domain.cache_versions import compose_version, embed_model_tag, normalise_tag


def test_namespace_composes_from_deps():
    v = CacheVersionRegistry()
    v.set_tag("catalog", "20260520")
    v.set_tag("library", "20260518")
    assert v.version_for("track_meta") == "20260520"
    assert v.version_for("pg_lib_search") == "0-20260518"


def test_embed_tag_seeds_the_embedding_namespaces():
    tag = embed_model_tag("openai", "text-embedding-3-small", 1536)
    v = CacheVersionRegistry(embed_model_tag=tag)
    assert v.version_for("embed_query") == tag
    assert v.snapshot() == {"catalog": "0", "library": "0", "embed_model": tag, "llm": "0"}


def test_unknown_namespace_returns_zero():
    assert CacheVersionRegistry().version_for("not_a_real_ns") == "0"
    assert compose_version("not_a_real_ns", {"catalog": "9"}) == "0"


def test_empty_and_long_tags_are_normalised():
    v = CacheVersionRegistry()
    v.set_tag("catalog", "")
    assert v.snapshot()["catalog"] == "0"
    v.set_tag("catalog", "x" * 40)
    assert v.snapshot()["catalog"] == "x" * 24
    assert normalise_tag("") == "0"


def test_snapshot_returns_copy():
    v = CacheVersionRegistry()
    snap = v.snapshot()
    snap["catalog"] = "tampered"
    assert v.snapshot()["catalog"] != "tampered"


def test_registries_do_not_share_state():
    a, b = CacheVersionRegistry(), CacheVersionRegistry()
    a.set_tag("catalog", "1")
    assert b.snapshot()["catalog"] == "0"
