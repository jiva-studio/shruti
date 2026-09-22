"""Per-namespace cache version segments.

Cache keys look like `lc:v1:{ns}:{ver}:{hash}` where `ver` is composed
from a small set of "tags" that describe everything the cached value
depends on.
"""

from __future__ import annotations

import asyncio  # noqa: F401
import hashlib
import threading
from typing import Iterable

from lectorium_chat.config import Settings
from lectorium_chat.observability.logging import get_logger

log = get_logger(__name__)

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


def _embed_model_tag(settings: Settings) -> str:
    raw = f"{settings.embed_provider}:{settings.embed_model}:{settings.embed_dim}"
    return hashlib.blake2b(raw.encode("utf-8"), digest_size=4).hexdigest()


def initialize_from_settings(settings: Settings) -> None:
    with _lock:
        _tags["embed_model"] = _embed_model_tag(settings)


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
            log.info("cache_version_bump", dep=dep, new=_tags[dep])


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


async def refresh_from_db(pool: "object") -> None:
    try:
        async with pool.acquire() as conn:  # type: ignore[attr-defined]
            rows = await conn.fetch(
                "SELECT kind, current_version FROM db_state"
            )
    except Exception as exc:  # noqa: BLE001
        log.warning("cache_version_refresh_failed", error=str(exc))
        return
    for row in rows:
        kind = row["kind"]
        version = row["current_version"]
        if kind in {"catalog", "library"} and version:
            set_tag(kind, str(version))


def bump_for_kinds(kinds: Iterable[str]) -> None:
    bump(*list(kinds))
