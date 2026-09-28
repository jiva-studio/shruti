"""`advisory_swap_lock` against connections that behave like Postgres sessions.

asyncpg cancels any statement that outlives the connection's `command_timeout`
(`db_command_timeout_s`, 15 s by default), so the lock must never be one
blocking statement: the fake only answers the non-blocking try. Session locks
die with the session: closing or terminating a connection releases them.
"""

from __future__ import annotations

import asyncio

import pytest

from shruti_chat.indexer import _swap


class _Server:
    """One Postgres: advisory locks shared by every connection."""

    def __init__(self) -> None:
        self.owners: dict[int, _AsyncpgLikeConn] = {}
        self.conns: list[_AsyncpgLikeConn] = []

    async def connect(self, _dsn: str, command_timeout_s: float) -> _AsyncpgLikeConn:
        conn = _AsyncpgLikeConn(self, command_timeout=command_timeout_s)
        self.conns.append(conn)
        return conn


class _AsyncpgLikeConn:
    def __init__(self, server: _Server, *, command_timeout: float) -> None:
        self._server = server
        self._command_timeout = command_timeout
        self.terminated = False
        self.closed = False
        self.statements: list[str] = []

    async def fetchval(self, sql: str, key: int, *, timeout: float | None = None) -> bool:
        self.statements.append(sql)
        assert "pg_try_advisory_lock(" in sql
        owner = self._server.owners.setdefault(key, self)
        return owner is self

    def _end_session(self) -> None:
        for key, owner in list(self._server.owners.items()):
            if owner is self:
                del self._server.owners[key]

    async def close(self, *, timeout: float | None = None) -> None:
        self.closed = True
        self._end_session()

    def terminate(self) -> None:
        self.terminated = True
        self._end_session()


_COMMAND_TIMEOUT_S = 0.05


@pytest.fixture()
def server(monkeypatch) -> _Server:
    s = _Server()
    monkeypatch.setattr(_swap, "_connect", s.connect)
    return s


def _lock(key: int = _swap.CATALOG_SWAP_LOCK_KEY, *, wait_s: float = 5.0):
    return _swap.advisory_swap_lock(
        key, dsn="postgres://fake", wait_s=wait_s,
        command_timeout_s=_COMMAND_TIMEOUT_S, poll_first_s=0.005, poll_max_s=0.02,
    )


async def test_a_waiter_outlasts_a_swap_longer_than_the_command_timeout(server: _Server) -> None:
    holding = asyncio.Event()
    release = asyncio.Event()

    async def _slow_swap() -> None:
        async with _lock():
            holding.set()
            await release.wait()

    first = asyncio.create_task(_slow_swap())
    await holding.wait()
    waiter = asyncio.create_task(_enter_and_leave())
    await asyncio.sleep(4 * _COMMAND_TIMEOUT_S)
    assert not waiter.done()
    release.set()
    await first
    await asyncio.wait_for(waiter, 1.0)


async def _enter_and_leave(key: int = _swap.CATALOG_SWAP_LOCK_KEY) -> None:
    async with _lock(key):
        pass


async def test_a_waiter_gives_up_at_the_wait_deadline(server: _Server) -> None:
    holding = asyncio.Event()
    release = asyncio.Event()

    async def _holder() -> None:
        async with _lock(7):
            holding.set()
            await release.wait()

    holder = asyncio.create_task(_holder())
    await holding.wait()
    with pytest.raises(TimeoutError):
        async with _lock(7, wait_s=0.05):
            pytest.fail("the body must not run without the lock")
    release.set()
    await holder
    holder_conn, waiter_conn = server.conns
    assert waiter_conn.terminated
    assert holder_conn.closed and not holder_conn.terminated


async def test_cancelled_while_waiting_the_holder_keeps_the_lock(server: _Server) -> None:
    holder_in = asyncio.Event()
    release = asyncio.Event()

    async def _holder() -> None:
        async with _lock(7):
            holder_in.set()
            await release.wait()

    holder = asyncio.create_task(_holder())
    await holder_in.wait()
    waiter = asyncio.create_task(_enter_and_leave(7))
    await asyncio.sleep(0.01)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    holder_conn, waiter_conn = server.conns
    assert waiter_conn.terminated
    assert server.owners[7] is holder_conn
    release.set()
    await holder


async def test_a_cancelled_swap_releases_the_lock(server: _Server) -> None:
    inside = asyncio.Event()

    async def _swap_forever() -> None:
        async with _lock(9):
            inside.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(_swap_forever())
    await inside.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert 9 not in server.owners
    # And the next swap gets the lock at once.
    await asyncio.wait_for(_enter_and_leave(9), 0.5)


async def test_a_failed_swap_releases_the_lock(server: _Server) -> None:
    with pytest.raises(RuntimeError):
        async with _lock(42):
            raise RuntimeError("swap failed")
    assert 42 not in server.owners


async def test_a_failed_close_after_the_swap_is_not_an_error(server: _Server) -> None:
    async def _broken_close(*, timeout: float | None = None) -> None:
        raise ConnectionError("lost")

    async with _lock(42):
        server.conns[0].close = _broken_close  # type: ignore[method-assign]
    assert server.conns[0].terminated
    assert 42 not in server.owners
