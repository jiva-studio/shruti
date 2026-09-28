"""`advisory_swap_lock` against a connection that behaves like asyncpg's.

asyncpg applies the pool's `command_timeout` to every statement that is not
given its own `timeout` (`Protocol._get_timeout_impl`), and the chat pool is
created with `command_timeout=db_command_timeout_s` (15 s by default). A
`pg_advisory_lock` that waits behind another process's swap is such a
statement, so the fake below reproduces that rule rather than blocking forever.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

from shruti_chat.indexer import _swap


class _Server:
    """One Postgres: advisory locks shared by every connection."""

    def __init__(self) -> None:
        self.locks: dict[int, asyncio.Lock] = {}

    def lock(self, key: int) -> asyncio.Lock:
        return self.locks.setdefault(key, asyncio.Lock())


class _AsyncpgLikeConn:
    def __init__(self, server: _Server, *, command_timeout: float) -> None:
        self._server = server
        self._command_timeout = command_timeout
        self.terminated = False
        self.statements: list[str] = []

    async def execute(self, sql: str, key: int, *, timeout: float | None = None) -> str:
        self.statements.append(sql)
        effective = self._command_timeout if timeout is None else timeout
        if "pg_advisory_lock(" in sql:
            await asyncio.wait_for(self._server.lock(key).acquire(), effective)
        elif "pg_advisory_unlock(" in sql:
            self._server.lock(key).release()
        return "SELECT 1"

    def terminate(self) -> None:
        self.terminated = True


class _Pool:
    def __init__(self, server: _Server, *, command_timeout: float) -> None:
        self._server = server
        self._command_timeout = command_timeout
        self.conns: list[_AsyncpgLikeConn] = []

    @asynccontextmanager
    async def acquire(self):
        conn = _AsyncpgLikeConn(self._server, command_timeout=self._command_timeout)
        self.conns.append(conn)
        yield conn


@pytest.fixture()
def pool(monkeypatch) -> _Pool:
    p = _Pool(_Server(), command_timeout=0.05)
    monkeypatch.setattr(_swap, "get_pool", lambda: p)
    return p


@pytest.mark.xfail(
    strict=True,
    raises=TimeoutError,
    reason="pg_advisory_lock inherits the pool's command_timeout, so a process "
    "waiting behind a swap longer than db_command_timeout_s fails instead of waiting",
)
async def test_a_waiter_outlasts_a_swap_longer_than_the_command_timeout(pool: _Pool) -> None:
    holding = asyncio.Event()
    release = asyncio.Event()

    async def _slow_swap() -> None:
        async with _swap.advisory_swap_lock(_swap.CATALOG_SWAP_LOCK_KEY):
            holding.set()
            await release.wait()

    first = asyncio.create_task(_slow_swap())
    await holding.wait()
    waiter = asyncio.create_task(_enter_and_leave())
    await asyncio.sleep(0.2)  # four command timeouts
    release.set()
    await first
    await waiter


async def _enter_and_leave() -> None:
    async with _swap.advisory_swap_lock(_swap.CATALOG_SWAP_LOCK_KEY):
        pass


async def test_cancelled_while_waiting_the_connection_is_not_reused(pool: _Pool) -> None:
    pool._command_timeout = 10.0  # noqa: SLF001 — wait long enough to be cancelled
    holder_in = asyncio.Event()
    release = asyncio.Event()

    async def _holder() -> None:
        async with _swap.advisory_swap_lock(7):
            holder_in.set()
            await release.wait()

    holder = asyncio.create_task(_holder())
    await holder_in.wait()
    waiter = asyncio.create_task(_enter_and_leave_key(7))
    await asyncio.sleep(0.01)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    release.set()
    await holder
    holder_conn, waiter_conn = pool.conns
    assert waiter_conn.terminated
    assert not holder_conn.terminated


async def _enter_and_leave_key(key: int) -> None:
    async with _swap.advisory_swap_lock(key):
        pytest.fail("the body must not run without the lock")


async def test_a_cancelled_swap_still_unlocks_and_keeps_its_connection(pool: _Pool) -> None:
    inside = asyncio.Event()

    async def _swap_forever() -> None:
        async with _swap.advisory_swap_lock(9):
            inside.set()
            await asyncio.Event().wait()

    task = asyncio.create_task(_swap_forever())
    await inside.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    (conn,) = pool.conns
    assert conn.statements[-1] == "SELECT pg_advisory_unlock($1)"
    assert not conn.terminated
    # And the next swap gets the lock at once.
    await asyncio.wait_for(_enter_and_leave_key_ok(9), 0.5)


async def _enter_and_leave_key_ok(key: int) -> None:
    async with _swap.advisory_swap_lock(key):
        pass
