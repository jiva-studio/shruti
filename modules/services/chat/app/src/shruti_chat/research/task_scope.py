"""Teardown for sibling tasks a turn stage starts with `asyncio.create_task`."""

from __future__ import annotations

import asyncio
from typing import Any


async def cancel_and_wait(*tasks: asyncio.Task[Any] | None) -> None:
    """Cancel whichever of `tasks` are still running and wait for all of them.

    Called from a `finally` so that a stage that is cancelled, or that raises
    (a provider-unavailable error re-raised by `run_stage`), takes its siblings
    down with it instead of leaving them running past the turn. Every task's
    outcome is collected, so a sibling that already failed is never reported
    as "Task exception was never retrieved". `None` entries are skipped.
    """
    live = [t for t in tasks if t is not None]
    for t in live:
        if not t.done():
            t.cancel()
    if live:
        await asyncio.gather(*live, return_exceptions=True)
