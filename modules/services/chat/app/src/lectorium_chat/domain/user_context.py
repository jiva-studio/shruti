"""Snapshot of on-device state sent with each /chat request.

This is the DOMAIN representation — frozen dataclasses with explicit
types and behaviour. The wire (HTTP) representation lives in
`lectorium_chat.api.schemas.chat` as Pydantic DTOs; the API endpoint
converts from one to the other at the request boundary.

The user listens to lectures; `recent_tracks` records that history with
position + percent. Derived slices ("in-progress now", "completed this
week") are queries against the listening history — they live as
methods on `UserContext` rather than ad-hoc filters scattered across
the tool layer.

`now` is the device's local wall-clock with the device's UTC offset
preserved (e.g. `datetime(2026, 5, 17, 19, 42, tzinfo=tz(+03:00))`).
Comparing `last_played_at` against `now` answers "yesterday" / "this
week" without an extra timezone field.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone, tzinfo
from typing import Literal


# Sentinel for sorting tracks with a missing `last_played_at` to the
# back. Must be tz-aware because `last_played_at` always is (the wire
# format carries the device's UTC offset).
_DT_MIN: datetime = datetime.min.replace(tzinfo=timezone.utc)


def as_aware(dt: datetime, tz: tzinfo | None = None) -> datetime:
    """Read a naive datetime in `tz` (the user's offset), UTC if unknown.

    Bounds reaching the domain can be naive — the LLM writes `since` /
    `until` itself and `datetime.fromisoformat("2026-08-03")` has no
    offset. Everything else in a UserContext is the device's local
    wall-clock, so an offset-less value means device-local too: pass
    `now.tzinfo` and a bare date lands on the user's midnight rather
    than five hours off it. UTC is the fallback for the one case where
    there is nothing better — no `now` on the context at all.
    """
    if dt.tzinfo is not None:
        return dt
    return dt.replace(tzinfo=tz or timezone.utc)


# Single source of truth for "in-progress" vs "completed" thresholds.
# Every filter on UserContext uses these so the LLM's tool calls and the
# system-prompt counters stay aligned.
IN_PROGRESS_MIN: float = 0.05
COMPLETED_MIN: float = 0.95


TrackStatus = Literal["any", "in_progress", "completed"]


@dataclass(frozen=True, slots=True)
class UserContextTrack:
    track_id: str
    position_ms: int | None = None
    percent: float | None = None
    last_played_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class FocusFragment:
    """User just tapped a specific span (e.g. an outline chapter) and the
    next message implicitly targets it. The agent should pull
    `chunks_get_window` around this range instead of guessing.

    `title` is informational for the LLM (rendered into the system
    prompt anchors block); tools receive only `track_id`, `start_ms`,
    `end_ms`."""

    track_id: str
    start_ms: int
    end_ms: int
    title: str | None = None


@dataclass(frozen=True, slots=True)
class UserContext:
    """Listening history lives in `recent_tracks` — each entry carries
    `percent` (0..1 fraction listened) and derivation lives on this
    class (`in_progress_tracks`, `completed_tracks`, `tracks_in_window`)
    rather than being re-implemented in each consumer.

    `user_id` is the internal UUID from the JWT `sub` claim, propagated
    through to Langfuse traces (`langfuse.trace(user_id=...)`) so the
    observability UI can group turns by user without leaking apple_id /
    google_play_id / email to the LLM provider or the trace store. See
    `observability/USER_ID.md`.
    """

    user_id: str | None = None
    current_track_id: str | None = None
    now: datetime | None = None
    recent_tracks: tuple[UserContextTrack, ...] = field(default_factory=tuple)
    focus: FocusFragment | None = None

    @property
    def tz(self) -> tzinfo | None:
        """The device's UTC offset, read off `now` — the one timezone this
        whole snapshot is expressed in. Anything offset-less that reaches
        us belongs in this frame; see `as_aware`."""
        return self.now.tzinfo if self.now is not None else None

    def in_progress_tracks(self) -> list[UserContextTrack]:
        """Tracks neither just-tapped nor near the end
        (IN_PROGRESS_MIN < percent < COMPLETED_MIN), recency-ordered."""
        return self._filter_recent(status="in_progress")

    def completed_tracks(self) -> list[UserContextTrack]:
        """Tracks the user has effectively finished (percent >= COMPLETED_MIN),
        recency-ordered."""
        return self._filter_recent(status="completed")

    def tracks_in_window(
        self,
        *,
        since: datetime | None = None,
        until: datetime | None = None,
        status: TrackStatus = "any",
    ) -> list[UserContextTrack]:
        """Tracks whose `last_played_at` falls in [since, until] (each bound
        inclusive; None means open). Status filter applies on top — pass
        "any" to skip the percent filter. Result is recency-ordered."""
        return self._filter_recent(status=status, since=since, until=until)

    def _filter_recent(
        self,
        *,
        status: TrackStatus,
        since: datetime | None = None,
        until: datetime | None = None,
    ) -> list[UserContextTrack]:
        tz = self.tz
        out: list[UserContextTrack] = []
        for t in self.recent_tracks:
            if not _matches_status(t.percent, status):
                continue
            if since is not None or until is not None:
                # Tracks with no `last_played_at` can't satisfy a time
                # bound — drop them when a window is active. (Without a
                # window they sort last via _DT_MIN; that's fine.)
                if t.last_played_at is None:
                    continue
                played = as_aware(t.last_played_at, tz)
                if since is not None and played < as_aware(since, tz):
                    continue
                if until is not None and played > as_aware(until, tz):
                    continue
            out.append(t)
        out.sort(
            key=lambda t: (
                as_aware(t.last_played_at, tz) if t.last_played_at else _DT_MIN
            ),
            reverse=True,
        )
        return out


def _matches_status(percent: float | None, status: TrackStatus) -> bool:
    if status == "any":
        return True
    if percent is None:
        return False
    if status == "in_progress":
        return IN_PROGRESS_MIN < percent < COMPLETED_MIN
    if status == "completed":
        return percent >= COMPLETED_MIN
    return False
