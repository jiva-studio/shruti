"""Per-namespace cache version segments.

Cache keys look like `lc:v1:{ns}:{ver}:{hash}` where `ver` is composed
from a small set of "tags" that describe everything the cached value
depends on:

  catalog       — bumped when the catalog SQLite is atomically swapped
  library       — bumped when the library Postgres rows are reloaded
  embed_model   — derived from settings (model id + dim); changes on
                  embedder rotation, which makes every cached embedding
                  and every cached ANN search instantly stale
  llm           — currently always empty (per-call llm_model is part of
                  the cache key tuple itself); kept for symmetry with
                  the dep table

Bumping a tag invalidates every namespace that depends on it WITHOUT
issuing DELs — old keys simply age out by TTL. This mirrors the
`outline_model_tag` pattern already in use for the S3-backed outline
cache.
"""

from __future__ import annotations

import asyncio  # noqa: F401
import hashlib
import threading
from typing import Iterable

from shruti_chat.config import Settings
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


# (ns) -> ordered list of dependency tags. Order matters only for
# determinism in the composed `ver` segment.
NAMESPACE_DEPS: dict[str, tuple[str, ...]] = {
    "router":          ("llm",),
    # Which language a given message should be answered in. Depends only on
    # the model — no catalog/corpus input (the reply language is not
    # constrained to the shipped locales).
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
    # Distinct corpus languages (SELECT DISTINCT lang FROM chunks). Bumped
    # whenever library rows reload — a reindex that adds a new language must
    # invalidate the cached set.
    "corpus_langs":    ("library",),
    # Persistent-cache-fronting Redis hot cache for MT-translated citation
    # text. Depends on both the translator model (`llm`) and the corpus
    # snapshot (`library`) — a reindex or model swap must not serve stale
    # translations.
    "translated_chunk": ("llm", "library"),
}


_lock = threading.Lock()
_tags: dict[str, str] = {
    "catalog": "0",
    "library": "0",
    "embed_model": "0",
    "llm": "0",
}


def _embed_model_tag(settings: Settings) -> str:
    raw = f"{settings.embed_provider}:{settings.embed_model}:{settings.embed_dim}"
    return hashlib.blake2b(raw.encode("utf-8"), digest_size=4).hexdigest()


def initialize_from_settings(settings: Settings) -> None:
    """Set the embed-model tag on startup. Catalog/library tags get
    refreshed by the indexer at swap time."""
    with _lock:
        _tags["embed_model"] = _embed_model_tag(settings)


def bump(*deps: str) -> None:
    """Increment one or more tags. Each bump appends `.N` to the existing
    value so the new key set is disjoint from the old one. Old keys age
    out by their own TTL; we never DELETE.
    """
    with _lock:
        for dep in deps:
            current = _tags.get(dep, "0")
            head, _, tail = current.rpartition(".")
            try:
                n = int(tail)
            except ValueError:
                n = 0
            new = f"{head}.{n + 1}" if head else f"{current}.1"
            # Keep it short: cap to last 16 chars so the ver segment
            # doesn't grow unbounded on a chatty indexer.
            _tags[dep] = new[-16:]
            log.info("cache_version_bump", dep=dep, new=_tags[dep])


def set_tag(dep: str, value: str) -> None:
    """Force-set a tag (used when the indexer reads the authoritative
    version from `db_state` and wants to mirror it verbatim)."""
    with _lock:
        _tags[dep] = (value or "0")[:24]


def cache_version_for(ns: str) -> str:
    """Compose the `ver` segment for namespace `ns`."""
    deps = NAMESPACE_DEPS.get(ns)
    if not deps:
        return "0"
    with _lock:
        return "-".join(_tags.get(d, "0") for d in deps)


def snapshot() -> dict[str, str]:
    """Read-only view of current tags. For /admin/status and tests."""
    with _lock:
        return dict(_tags)


# ── async refresh from Postgres db_state ──────────────────────────────


async def refresh_from_db(pool: "object") -> None:
    """Pull catalog / library current_version from `db_state` and mirror
    into the in-memory tag map. Called on startup and after each indexer
    swap so the in-memory view never drifts from the DB.
    """
    try:
        async with pool.acquire() as conn:  # type: ignore[attr-defined]
            rows = await conn.fetch(
                "SELECT kind, current_version FROM db_state"
            )
    except Exception as exc:  # noqa: BLE001 — best-effort
        log.warning("cache_version_refresh_failed", error=str(exc))
        return
    for row in rows:
        kind = row["kind"]
        version = row["current_version"]
        if kind in {"catalog", "library"} and version:
            set_tag(kind, str(version))


def bump_for_kinds(kinds: Iterable[str]) -> None:
    """Convenience for the indexer: bump every tag named in `kinds`."""
    bump(*list(kinds))
