"""The process's cache version tags, held in memory behind `CacheVersions`."""

from __future__ import annotations

import threading

from shruti_chat.domain.cache_versions import DEFAULT_TAGS, compose_version, normalise_tag


class CacheVersionRegistry:
    """Thread-safe tag store; the indexer writes it, every cache key reads it."""

    def __init__(self, *, embed_model_tag: str | None = None) -> None:
        self._lock = threading.Lock()
        self._tags: dict[str, str] = dict(DEFAULT_TAGS)
        if embed_model_tag is not None:
            self._tags["embed_model"] = embed_model_tag

    def version_for(self, ns: str) -> str:
        with self._lock:
            return compose_version(ns, self._tags)

    def set_tag(self, dep: str, value: str) -> None:
        with self._lock:
            self._tags[dep] = normalise_tag(value)

    def snapshot(self) -> dict[str, str]:
        with self._lock:
            return dict(self._tags)
