"""Per-namespace cache version segments.

Cache keys look like `lc:v1:{ns}:{ver}:{hash}` where `ver` is composed
from a small set of "tags" that describe everything the cached value
depends on:

  catalog       — the version of the published catalog SQLite
  library       — the version of the published library snapshot
  embed_model   — derived from model id + dim
  llm           — per-call llm_model

The tags themselves are process state and live behind the `CacheVersions`
port; this module holds only the rules for composing them.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping

NAMESPACE_DEPS: dict[str, tuple[str, ...]] = {
    "router":          ("llm",),
    "reply_lang":      ("llm",),
    "title":           ("llm",),
    "attr_confirm":    ("llm", "catalog"),
    "caption":         ("llm", "library"),
    "topic":           ("llm",),
    "embed_query":     ("embed_model",),
    "pg_chunk_search": ("embed_model", "library"),
    "pg_lib_search":   ("embed_model", "library"),
    "pg_window":       ("library",),
    "track_meta":      ("catalog",),
    "author_names":    ("catalog",),
    "corpus_langs":    ("library",),
    "translated_chunk": ("llm", "library"),
}

DEFAULT_TAGS: Mapping[str, str] = {
    "catalog": "0",
    "library": "0",
    "embed_model": "0",
    "llm": "0",
}


def embed_model_tag(provider: str, model: str, dim: int) -> str:
    raw = f"{provider}:{model}:{dim}"
    return hashlib.blake2b(raw.encode("utf-8"), digest_size=4).hexdigest()


def normalise_tag(value: str) -> str:
    """The stored form of a tag: never empty, at most 24 characters."""
    return (value or "0")[:24]


def compose_version(ns: str, tags: Mapping[str, str]) -> str:
    """The version segment of namespace `ns` given the current tags."""
    deps = NAMESPACE_DEPS.get(ns)
    if not deps:
        return "0"
    return "-".join(tags.get(d, "0") for d in deps)
