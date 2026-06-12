"""No-op TurnStore — used when Redis isn't configured.

The resume / reconnect feature is simply off: nothing is buffered, every
`get` returns None (polls 404), and turns are never marked cancelled. The
live SSE stream is unaffected.
"""

from __future__ import annotations

from typing import Any


class NoopTurnStore:
    async def mark_running(self, trace_id: str, user_id: str) -> None:
        return None

    async def heartbeat(self, trace_id: str) -> None:
        return None

    async def finish(
        self, trace_id: str, *, state: str, events: list[dict[str, Any]], user_id: str
    ) -> None:
        return None

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return None

    async def request_cancel(self, trace_id: str) -> None:
        return None

    async def is_cancelled(self, trace_id: str) -> bool:
        return False
