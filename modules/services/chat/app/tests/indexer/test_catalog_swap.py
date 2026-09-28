"""Catalog / library swap: concurrent callers never share a download.

A manual `/reindex` and the scheduled `run_once` both call `ensure_catalog`
(and `ensure_library`). Each swap is serialised by a module lock, downloads
into its own temp file, and leaves nothing behind in `.tmp` when it fails.
"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest

from shruti_chat.application.cache_versions import CacheVersionRegistry
from shruti_chat.indexer import catalog, s3
from shruti_chat.indexer.library import db as library_db

_CATALOG_TABLES = (
    "tracks", "track_variants", "authors", "locations", "tags",
    "sources", "track_tags", "track_references",
)
_LIBRARY_TABLES = (
    "library_verses", "library_verse_variants", "library_documents",
    "library_document_variants", "library_titles",
)


def _write_db(path: Path, tables: tuple[str, ...]) -> None:
    with closing(sqlite3.connect(path)) as c:
        for t in tables:
            c.execute(f"CREATE TABLE {t} (id TEXT)")
        c.commit()


def _settings(tmp_path: Path) -> SimpleNamespace:
    return SimpleNamespace(
        catalog_dir=tmp_path,
        catalog_db_path=tmp_path / "catalog.db",
        library_db_path=tmp_path / "library.db",
    )


class _Downloads:
    """A fake CDN download that yields mid-write and records overlap."""

    def __init__(self, tables: tuple[str, ...]) -> None:
        self.tables = tables
        self.active = 0
        self.max_active = 0
        self.paths: list[Path] = []

    async def __call__(self, version: str, dest: Path, settings=None) -> None:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.paths.append(dest)
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"")
            await asyncio.sleep(0.01)
            _write_db(dest, self.tables)
        finally:
            self.active -= 1


class _BrokenTags(CacheVersionRegistry):
    def set_tag(self, dep: str, value: str) -> None:
        raise RuntimeError("tag store down")


@pytest.fixture()
def catalog_env(tmp_path: Path, monkeypatch):
    state = {"version": None}

    async def _read() -> str | None:
        return state["version"]

    async def _write(v: str) -> None:
        state["version"] = v

    async def _manifest(_s):
        return [s3.CatalogManifestEntry(version="2")]

    downloads = _Downloads(_CATALOG_TABLES)
    monkeypatch.setattr(catalog, "read_current_version", _read)
    monkeypatch.setattr(catalog, "write_current_version", _write)
    monkeypatch.setattr(s3, "read_catalog_manifest", _manifest)
    monkeypatch.setattr(s3, "download_catalog", downloads)
    monkeypatch.setattr(catalog, "_swap_lock", asyncio.Lock(), raising=False)
    return SimpleNamespace(
        settings=_settings(tmp_path), downloads=downloads, state=state,
        versions=CacheVersionRegistry(),
    )


@pytest.fixture()
def library_env(tmp_path: Path, monkeypatch):
    state = {"version": None}

    async def _read() -> str | None:
        return state["version"]

    async def _write(v: str) -> None:
        state["version"] = v

    async def _manifest(_s):
        return [s3.LibraryManifestEntry(version="7")]

    downloads = _Downloads(_LIBRARY_TABLES)
    monkeypatch.setattr(library_db, "read_current_version", _read)
    monkeypatch.setattr(library_db, "write_current_version", _write)
    monkeypatch.setattr(s3, "read_library_manifest", _manifest)
    monkeypatch.setattr(s3, "download_library", downloads)
    monkeypatch.setattr(library_db, "_swap_lock", asyncio.Lock(), raising=False)
    return SimpleNamespace(
        settings=_settings(tmp_path), downloads=downloads, state=state,
        versions=CacheVersionRegistry(),
    )


async def test_concurrent_forced_catalog_swaps_never_overlap(catalog_env) -> None:
    s = catalog_env.settings
    results = await asyncio.gather(
        catalog.ensure_catalog(s, force=True, cache_versions=catalog_env.versions),
        catalog.ensure_catalog(s, force=True, cache_versions=catalog_env.versions),
    )
    assert results == ["2", "2"]
    assert catalog_env.downloads.max_active == 1
    assert len(set(catalog_env.downloads.paths)) == 2  # one temp file per call
    catalog._verify_catalog_file(s.catalog_db_path)
    assert list((s.catalog_dir / ".tmp").iterdir()) == []


async def test_waiting_catalog_caller_skips_after_the_first_swap(catalog_env) -> None:
    s = catalog_env.settings
    versions = catalog_env.versions
    results = await asyncio.gather(
        catalog.ensure_catalog(s, cache_versions=versions),
        catalog.ensure_catalog(s, cache_versions=versions),
    )
    assert sorted(results, key=str) == ["2", None]
    assert len(catalog_env.downloads.paths) == 1


async def test_rejected_catalog_download_leaves_no_temp_and_keeps_live_file(
    catalog_env, monkeypatch,
) -> None:
    s = catalog_env.settings
    _write_db(s.catalog_db_path, _CATALOG_TABLES)
    live_before = s.catalog_db_path.read_bytes()
    catalog_env.downloads.tables = ("tracks",)  # missing required tables

    with pytest.raises(RuntimeError, match="missing tables"):
        await catalog.ensure_catalog(s, force=True, cache_versions=catalog_env.versions)

    assert s.catalog_db_path.read_bytes() == live_before
    assert list((s.catalog_dir / ".tmp").iterdir()) == []
    assert catalog_env.state["version"] is None


async def test_catalog_verify_runs_off_the_event_loop(catalog_env, monkeypatch) -> None:
    threads: list[threading.Thread] = []
    real = catalog._verify_catalog_file

    def _spy(path: Path) -> None:
        threads.append(threading.current_thread())
        real(path)

    monkeypatch.setattr(catalog, "_verify_catalog_file", _spy)
    await catalog.ensure_catalog(
        catalog_env.settings, force=True, cache_versions=catalog_env.versions,
    )
    assert threads and threads[0] is not threading.main_thread()


async def test_catalog_cache_invalidation_failure_is_logged_not_swallowed(
    catalog_env, monkeypatch,
) -> None:
    logged: list[str] = []
    catalog_env.versions = _BrokenTags()
    monkeypatch.setattr(catalog.log, "exception", lambda event, **_kw: logged.append(event))

    assert await catalog.ensure_catalog(
        catalog_env.settings, force=True, cache_versions=catalog_env.versions,
    ) == "2"
    assert logged == ["catalog_cache_invalidate_failed"]


async def test_catalog_swap_bumps_the_catalog_cache_tag(catalog_env) -> None:
    await catalog.ensure_catalog(
        catalog_env.settings, force=True, cache_versions=catalog_env.versions,
    )
    assert catalog_env.versions.snapshot()["catalog"] == "2"


async def test_concurrent_forced_library_swaps_never_overlap(library_env) -> None:
    s = library_env.settings
    results = await asyncio.gather(
        library_db.ensure_library(s, force=True, cache_versions=library_env.versions),
        library_db.ensure_library(s, force=True, cache_versions=library_env.versions),
    )
    assert results == ["7", "7"]
    assert library_env.downloads.max_active == 1
    assert len(set(library_env.downloads.paths)) == 2
    library_db._verify_library_file(s.library_db_path)
    assert list((s.catalog_dir / ".tmp").iterdir()) == []


async def test_library_swap_bumps_the_library_cache_tag(library_env) -> None:
    await library_db.ensure_library(
        library_env.settings, force=True, cache_versions=library_env.versions,
    )
    assert library_env.versions.snapshot()["library"] == "7"


async def test_library_cache_invalidation_failure_is_logged(library_env, monkeypatch) -> None:
    logged: list[str] = []
    library_env.versions = _BrokenTags()
    monkeypatch.setattr(library_db.log, "exception", lambda event, **_kw: logged.append(event))

    assert await library_db.ensure_library(
        library_env.settings, force=True, cache_versions=library_env.versions,
    ) == "7"
    assert logged == ["library_cache_invalidate_failed"]
