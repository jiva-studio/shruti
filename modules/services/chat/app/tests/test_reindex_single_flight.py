"""POST /reindex must not spawn overlapping indexer runs.

The route fired `asyncio.create_task(run_once(...))` with no guard and kept no
reference to the task. N requests meant N full runs, each opening 8 concurrent
transcript workers against the shared pool and paying for its own embeddings,
racing each other's GC deletes. The done-callback called `task.exception()` and
threw the result away, so a failed run left no trace either.

The handler is driven directly rather than through TestClient: TestClient runs
each request on its own event loop, so a task spawned by the first request is
already dead by the second — which is precisely the state under test.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi import HTTPException

from shruti_chat.api import admin as admin_api
from shruti_chat.api.admin import ReindexRequest


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(admin_api, "_reindex_task", None)
    monkeypatch.setattr(admin_api, "_check_token", lambda token: None)
    yield
    task = admin_api._reindex_task
    if task is not None and not task.done():
        task.cancel()
    admin_api._reindex_task = None


async def _reindex() -> dict[str, Any]:
    return await admin_api.reindex(ReindexRequest(), x_app_token="t")


async def test_second_request_while_running_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = asyncio.Event()

    async def _slow_run(**kwargs: Any) -> str:
        await release.wait()
        return "r-slow"

    monkeypatch.setattr(admin_api.indexer_run, "run_once", _slow_run)

    assert (await _reindex())["accepted"] is True
    await asyncio.sleep(0)  # let the task actually start

    with pytest.raises(HTTPException) as err:
        await _reindex()
    assert err.value.status_code == 409

    release.set()


async def test_a_finished_run_frees_the_slot(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _quick_run(**kwargs: Any) -> str:
        return "r-quick"

    monkeypatch.setattr(admin_api.indexer_run, "run_once", _quick_run)

    await _reindex()
    await asyncio.sleep(0)  # the run completes
    await asyncio.sleep(0)  # done-callback fires

    assert (await _reindex())["accepted"] is True


async def test_a_failed_run_is_logged(monkeypatch: pytest.MonkeyPatch) -> None:
    logged: list[tuple[str, dict]] = []

    class _Log:
        def error(self, event: str, **kw: Any) -> None:
            logged.append((event, kw))

        def info(self, event: str, **kw: Any) -> None:
            logged.append((event, kw))

        def warning(self, event: str, **kw: Any) -> None:
            logged.append((event, kw))

    async def _failing_run(**kwargs: Any) -> str:
        raise RuntimeError("indexer blew up")

    monkeypatch.setattr(admin_api, "log", _Log())
    monkeypatch.setattr(admin_api.indexer_run, "run_once", _failing_run)

    await _reindex()
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert ("reindex_failed", {"error": "indexer blew up"}) in logged


async def test_a_successful_run_reports_its_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged: list[tuple[str, dict]] = []

    class _Log:
        def error(self, event: str, **kw: Any) -> None:
            logged.append((event, kw))

        def info(self, event: str, **kw: Any) -> None:
            logged.append((event, kw))

        def warning(self, event: str, **kw: Any) -> None:
            logged.append((event, kw))

    async def _ok_run(**kwargs: Any) -> str:
        return "r-abc123"

    monkeypatch.setattr(admin_api, "log", _Log())
    monkeypatch.setattr(admin_api.indexer_run, "run_once", _ok_run)

    await _reindex()
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert ("reindex_finished", {"run_id": "r-abc123"}) in logged
