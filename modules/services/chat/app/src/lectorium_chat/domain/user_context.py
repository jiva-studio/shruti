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
from datetime import datetime, timezone


# Sentinel for sorting tracks with a missing `last_played_at` to the
# back. Must be tz-aware because `last_played_at` always is (the wire
# format carries the device's UTC offset).
_DT_MIN: datetime = datetime.min.replace(tzinfo=timezone.utc)


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
    `get_transcript_window` around this range instead of guessing.

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
    class (`in_progress_tracks`, `completed_tracks`) rather than being
    re-implemented in each consumer."""

    current_track_id: str | None = None
    now: datetime | None = None
    recent_tracks: tuple[UserContextTrack, ...] = field(default_factory=tuple)
    focus: FocusFragment | None = None

    def in_progress_tracks(self) -> list[UserContextTrack]:
        """Recently-listened tracks that are neither just-tapped nor near
        the end (0.05 < percent < 0.95), ordered by recency. Used by
        `continue_listening` and surfaced as a count in the system
        prompt so the LLM knows whether the personalize tools have
        anything to return."""
        filtered = [
            t for t in self.recent_tracks
            if t.percent is not None and 0.05 < t.percent < 0.95
        ]
        filtered.sort(
            key=lambda t: t.last_played_at or _DT_MIN,
            reverse=True,
        )
        return filtered
