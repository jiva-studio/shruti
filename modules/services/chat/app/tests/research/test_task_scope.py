"""cancel_and_wait returns only once every sibling has finished."""

from __future__ import annotations

import asyncio

from shruti_chat.research.task_scope import cancel_and_wait


async def test_waits_until_cancelled_siblings_have_finished() -> None:
    cleaned_up = []

    async def sibling() -> None:
        try:
            await asyncio.sleep(3600)
        finally:
            cleaned_up.append(True)

    a = asyncio.create_task(sibling())
    b = asyncio.create_task(sibling())
    await asyncio.sleep(0)

    await cancel_and_wait(a, None, b)

    assert a.cancelled() and b.cancelled()
    assert cleaned_up == [True, True]


async def test_collects_a_failed_sibling_without_raising() -> None:
    async def boom() -> None:
        raise RuntimeError("provider down")

    failed = asyncio.create_task(boom())
    await asyncio.sleep(0)

    await cancel_and_wait(failed)

    assert isinstance(failed.exception(), RuntimeError)


async def test_nothing_to_wait_for() -> None:
    await cancel_and_wait(None, None)
