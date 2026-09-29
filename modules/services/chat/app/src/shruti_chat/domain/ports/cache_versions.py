"""CacheVersions — port for the version tags every cache key is built on.

One instance per process, built by the composition root and shared by the
memo cache that reads the tags and the indexer that moves them on a swap.
"""

from __future__ import annotations

from typing import Protocol


class CacheVersions(Protocol):
    def version_for(self, ns: str) -> str:
        """The version segment keys in namespace `ns` are written under."""
        ...

    def set_tag(self, dep: str, value: str) -> None:
        """Record the current value of one tag (`catalog`, `library`, …)."""
        ...

    def snapshot(self) -> dict[str, str]:
        """A copy of every tag."""
        ...
