"""`run_once` retires cached transcript searches exactly when a pass wrote or
removed transcript chunks."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from shruti_chat.application.cache_versions import CacheVersionRegistry
from shruti_chat.indexer import run as indexer_run
from shruti_chat.indexer.s3 import TranscriptObject


class _Conn:
    def __init__(self, indexed: list[dict[str, str]]) -> None:
        self._indexed = indexed

    async def execute(self, *_a: Any) -> str:
        return "OK"

    async def fetch(self, *_a: Any) -> list[dict[str, str]]:
        return self._indexed


class _Pool:
    def __init__(self, indexed: list[dict[str, str]]) -> None:
        self._indexed = indexed

    def acquire(self) -> "_Pool":
        return self

    async def __aenter__(self) -> _Conn:
        return _Conn(self._indexed)

    async def __aexit__(self, *_a: Any) -> None:
        return None


def _obj(track_id: str, etag: str) -> TranscriptObject:
    return TranscriptObject(track_id=track_id, lang="en", key=f"{track_id}.json", etag=etag)


@pytest.fixture
def indexer(monkeypatch: pytest.MonkeyPatch):
    state: dict[str, Any] = {"listed": [], "indexed": [], "bumps": 0, "gc": []}

    async def _none(*_a: Any, **_k: Any) -> None:
        return None

    async def _process_one(*_a: Any, **_k: Any) -> int:
        return 3

    async def _gc(_pool: Any, stale: list, _model: str) -> None:
        state["gc"].extend(stale)

    async def _library(*_a: Any, **_k: Any) -> dict[str, int]:
        return {}

    async def _bump(_versions: Any) -> str:
        state["bumps"] += 1
        return "v"

    monkeypatch.setattr(indexer_run, "get_embedder", lambda _s: SimpleNamespace(name="m"))
    monkeypatch.setattr(indexer_run, "get_pool", lambda: _Pool(state["indexed"]))
    monkeypatch.setattr(indexer_run.catalog, "read_current_version", _none)
    monkeypatch.setattr(indexer_run.catalog, "ensure_catalog", _none)
    monkeypatch.setattr(indexer_run.s3, "list_transcripts", lambda *_a: state["listed"])
    monkeypatch.setattr(indexer_run, "_process_one", _process_one)
    monkeypatch.setattr(indexer_run, "delete_stale_transcripts", _gc)
    monkeypatch.setattr(indexer_run, "run_once_library", _library)
    monkeypatch.setattr(indexer_run, "run_once_attribution", _library)
    monkeypatch.setattr(indexer_run, "bump_transcripts_version", _bump)
    return state


async def _run() -> None:
    settings = SimpleNamespace(langs=["en"], indexer_concurrency=2)
    await indexer_run.run_once(settings, cache_versions=CacheVersionRegistry())


async def test_a_pass_that_indexes_a_transcript_bumps_once(indexer) -> None:
    indexer["listed"] = [_obj("t1", "new"), _obj("t2", "new")]

    await _run()

    assert indexer["bumps"] == 1


async def test_a_pass_with_nothing_changed_keeps_the_tag(indexer) -> None:
    indexer["listed"] = [_obj("t1", "e1")]
    indexer["indexed"] = [{"item_id": "t1", "lang": "en", "etag": "e1"}]

    await _run()

    assert indexer["bumps"] == 0


async def test_a_pass_that_only_removes_transcripts_bumps(indexer) -> None:
    indexer["listed"] = [_obj(f"t{i}", "e") for i in range(9)]
    indexer["indexed"] = [
        {"item_id": f"t{i}", "lang": "en", "etag": "e"} for i in range(10)
    ]

    await _run()

    assert indexer["gc"] == [("t9", "en")]
    assert indexer["bumps"] == 1


async def test_a_pass_cancelled_after_a_write_still_bumps(
    indexer, monkeypatch: pytest.MonkeyPatch
) -> None:
    indexer["listed"] = [_obj("t1", "new"), _obj("t2", "new")]
    second_started = asyncio.Event()

    async def _process_one(obj: TranscriptObject, *_a: Any, **_k: Any) -> int:
        if obj.track_id == "t1":
            return 3
        second_started.set()
        await asyncio.Event().wait()
        return 0

    monkeypatch.setattr(indexer_run, "_process_one", _process_one)
    settings = SimpleNamespace(langs=["en"], indexer_concurrency=1)
    task = asyncio.create_task(
        indexer_run.run_once(settings, cache_versions=CacheVersionRegistry())
    )
    await second_started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    assert indexer["bumps"] == 1
