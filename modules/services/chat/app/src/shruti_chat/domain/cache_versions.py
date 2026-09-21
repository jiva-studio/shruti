"""Per-namespace cache version segments.

Cache keys look like `lc:v1:{ns}:{ver}:{hash}` where `ver` is composed
from a small set of "tags" that describe everything the cached value
depends on:

  catalog       — bumped when the catalog SQLite is atomically swapped
  library       — bumped when the library Postgres rows are reloaded
  embed_model   — derived from model id + dim
  llm           — per-call llm_model
"""

from __future__ import annotations

import hashlib
import threading
from typing import Iterable

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

_lock = threading.Lock()
_tags: dict[str, str] = {
    "catalog": "0",
    "library": "0",
    "embed_model": "0",
    "llm": "0",
}


def embed_model_tag(provider: str, model: str, dim: int) -> str:
    raw = f"{provider}:{model}:{dim}"
    return hashlib.blake2b(raw.encode("utf-8"), digest_size=4).hexdigest()


def initialize_embed_tag(provider: str, model: str, dim: int) -> None:
    with _lock:
        _tags["embed_model"] = embed_model_tag(provider, model, dim)


def bump(*deps: str) -> None:
    with _lock:
        for dep in deps:
            current = _tags.get(dep, "0")
            head, _, tail = current.rpartition(".")
            try:
                n = int(tail)
            except ValueError:
                n = 0
            new = f"{head}.{n + 1}" if head else f"{current}.1"
            _tags[dep] = new[-16:]


def set_tag(dep: str, value: str) -> None:
    with _lock:
        _tags[dep] = (value or "0")[:24]


def cache_version_for(ns: str) -> str:
    deps = NAMESPACE_DEPS.get(ns)
    if not deps:
        return "0"
    with _lock:
        return "-".join(_tags.get(d, "0") for d in deps)


def snapshot() -> dict[str, str]:
    with _lock:
        return dict(_tags)


def bump_for_kinds(kinds: Iterable[str]) -> None:
    bump(*list(kinds))
