"""TurnStore port — buffers a chat turn's SSE events so a client that
dropped the connection (backgrounded, navigated away, app killed) can
fetch the finished answer when it returns instead of losing it.

The turn runs in a detached task that keeps generating after the socket
closes; it writes the full ordered event list ONCE on completion
(state=done|error) with a 24h TTL. While running, a short-lived
`running` marker with a heartbeat lets a reconnecting client see "still
generating" and lets us detect a turn orphaned by a server restart (the
marker's TTL lapses with no heartbeat → the record disappears → the
client treats it as lost).

Concrete impl in `infra/turn_store/`. No-op when Redis is unconfigured —
the resume feature is simply off (`get` returns None, every poll 404s).
"""

from __future__ import annotations

from typing import Any, Protocol


class TurnStore(Protocol):
    async def mark_running(self, trace_id: str, user_id: str) -> None:
        """Write the early `running` marker (before generation) so a poll
        can distinguish "in progress" from "never received" (absent →
        404). Carries `user_id` for ownership checks on GET/DELETE."""
        ...

    async def heartbeat(self, trace_id: str) -> None:
        """Refresh the `running` marker's liveness TTL. If the producer
        dies (server redeploy) the marker lapses and the turn reads as
        orphaned."""
        ...

    async def finish(
        self, trace_id: str, *, state: str, events: list[dict[str, Any]], user_id: str
    ) -> None:
        """Persist the completed turn (state + verbatim ordered SSE event
        list) with the result TTL, overwriting the `running` marker."""
        ...

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        """Read the turn record (`running` marker or finished blob), or
        None when absent/expired. Implementations MUST degrade to None on
        a backing-store error rather than raise."""
        ...

    async def request_cancel(self, trace_id: str) -> None:
        """Set a cross-replica cancel flag the producer polls via
        `is_cancelled` — used by an explicit Stop (DELETE) that may land
        on a different replica than the one running the turn."""
        ...

    async def is_cancelled(self, trace_id: str) -> bool:
        """True when an explicit cancel was requested. MUST degrade to
        False on a backing-store error (never cancel a turn for an infra
        hiccup)."""
        ...
