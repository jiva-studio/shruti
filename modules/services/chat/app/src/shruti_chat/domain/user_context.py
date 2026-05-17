"""Snapshot of on-device state sent with each /chat request.

`UserContext` is built mobile-side from the user DB (recent listening,
in-progress tracks, notes) and the player state (current track, focus
fragment). The server hands it to personalize tools via closure binding
in `agent.tools.build_personalized_tools` — the LLM never sees its
contents directly.

Defined in `domain/` rather than `api/` because both API and agent code
read it; keeping it in `api/` would force `agent/` to import `api/`,
which inverts the layering.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class UserContextTrack(BaseModel):
    track_id: str
    position_ms: int | None = None
    percent: float | None = None
    last_played_at: str | None = None
    completed: bool = False


class UserNote(BaseModel):
    track_id: str | None = None
    time_start_ms: int | None = None
    time_end_ms: int | None = None
    text: str
    created_at: str | None = None


class FocusFragment(BaseModel):
    """User just tapped a specific span (e.g. an outline chapter) and the
    next message implicitly targets it. The agent should pull
    `get_transcript_window` around this range instead of guessing."""

    track_id: str
    start_ms: int
    end_ms: int
    title: str | None = None


class UserContext(BaseModel):
    """`now` and `tz_offset_minutes` let temporal queries ("yesterday",
    "a week ago") resolve against the user's wall clock, not the
    server's UTC. `last_played_at` on each track / note is then
    comparable to `now` for relative-time filtering.
    """

    current_track_id: str | None = None
    now: str | None = None  # ISO-8601 with offset, device local time
    tz_offset_minutes: int | None = None
    recent_tracks: list[UserContextTrack] = Field(default_factory=list, max_length=20)
    in_progress: list[UserContextTrack] = Field(default_factory=list, max_length=10)
    recent_notes: list[UserNote] = Field(default_factory=list, max_length=30)
    focus: FocusFragment | None = None
