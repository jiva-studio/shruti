"""`advisory_swap_lock` against a real Postgres.

Marked `needs_db`, so skipped without --integration / SHRUTI_INTEGRATION_DB.
The command timeout is set far below the holder's swap, which is what a
catalog download does to a 15 s `db_command_timeout_s` in production.
"""

from __future__ import annotations

import asyncio
import secrets

import pytest

from shruti_chat.indexer._swap import advisory_swap_lock

pytestmark = [pytest.mark.asyncio, pytest.mark.needs_db]

_COMMAND_TIMEOUT_S = 0.3


def _lock(url: str, key: int, *, wait_s: float):
    return advisory_swap_lock(
        key, dsn=url, wait_s=wait_s, command_timeout_s=_COMMAND_TIMEOUT_S,
        poll_first_s=0.02, poll_max_s=0.1,
    )


async def test_a_waiter_acquires_after_a_swap_longer_than_the_command_timeout(
    integration_db_url: str,
) -> None:
    key = secrets.randbits(62)
    holding = asyncio.Event()
    events: list[str] = []

    async def _holder() -> None:
        async with _lock(integration_db_url, key, wait_s=5):
            holding.set()
            await asyncio.sleep(4 * _COMMAND_TIMEOUT_S)
            events.append("holder out")

    async def _waiter() -> None:
        await holding.wait()
        async with _lock(integration_db_url, key, wait_s=10):
            events.append("waiter in")

    await asyncio.wait_for(asyncio.gather(_holder(), _waiter()), 15)
    assert events == ["holder out", "waiter in"]


async def test_a_waiter_gives_up_at_its_deadline(integration_db_url: str) -> None:
    key = secrets.randbits(62)
    holding = asyncio.Event()
    release = asyncio.Event()

    async def _holder() -> None:
        async with _lock(integration_db_url, key, wait_s=5):
            holding.set()
            await release.wait()

    holder = asyncio.create_task(_holder())
    await holding.wait()
    try:
        with pytest.raises(TimeoutError):
            async with _lock(integration_db_url, key, wait_s=2 * _COMMAND_TIMEOUT_S):
                pytest.fail("the body must not run without the lock")
    finally:
        release.set()
        await holder
    # The holder's session is gone, and the lock with it.
    async with _lock(integration_db_url, key, wait_s=1):
        pass
