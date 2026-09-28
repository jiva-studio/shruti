"""`refresh_cache_versions_from_db`: db_state → the domain's version tags."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from shruti_chat.domain import cache_versions
from shruti_chat.infra.cache.cache_version_sync import refresh_cache_versions_from_db


@pytest.fixture(autouse=True)
def _own_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        cache_versions,
        "_tags",
        {"catalog": "0", "library": "0", "embed_model": "e1", "llm": "0"},
    )


class _Pool:
    def __init__(self, rows: list[dict[str, Any]] | None = None, *, fail: bool = False):
        self._rows = rows or []
        self._fail = fail

    @asynccontextmanager
    async def acquire(self):
        if self._fail:
            raise ConnectionError("pool exhausted")
        yield self

    async def fetch(self, query: str) -> list[dict[str, Any]]:
        assert query == "SELECT kind, current_version FROM db_state"
        return self._rows


async def test_mirrors_catalog_and_library_versions() -> None:
    await refresh_cache_versions_from_db(
        _Pool([
            {"kind": "catalog", "current_version": "20260920"},
            {"kind": "library", "current_version": 20260918},
        ])
    )
    snap = cache_versions.snapshot()
    assert snap["catalog"] == "20260920"
    assert snap["library"] == "20260918"
    assert cache_versions.cache_version_for("pg_chunk_search") == "e1-20260918"


async def test_ignores_other_kinds_and_empty_versions() -> None:
    await refresh_cache_versions_from_db(
        _Pool([
            {"kind": "embed_model", "current_version": "hijack"},
            {"kind": "catalog", "current_version": None},
            {"kind": "library", "current_version": ""},
        ])
    )
    assert cache_versions.snapshot() == {
        "catalog": "0", "library": "0", "embed_model": "e1", "llm": "0",
    }


async def test_unreadable_db_state_leaves_tags_untouched() -> None:
    await refresh_cache_versions_from_db(_Pool(fail=True))
    assert cache_versions.snapshot()["catalog"] == "0"
