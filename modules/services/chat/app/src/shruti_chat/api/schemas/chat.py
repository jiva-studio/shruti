"""HTTP DTOs for POST /chat.

Wire shape stays string-based for timestamps (ISO-8601 with offset) so
mobile parsing is unchanged. The `to_domain` helpers convert into the
typed domain entities (`UserContext`, `FocusFragment`, ...).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from shruti_chat.domain.user_context import (
    FocusFragment,
    UserContext,
    UserContextTrack,
)


class UserContextTrackDto(BaseModel):
    track_id: str
    position_ms: int | None = None
    percent: float | None = None
    last_played_at: str | None = None  # ISO-8601 with offset

    def to_domain(self) -> UserContextTrack:
        return UserContextTrack(
            track_id=self.track_id,
            position_ms=self.position_ms,
            percent=self.percent,
            last_played_at=_parse_iso(self.last_played_at),
        )


class FocusFragmentDto(BaseModel):
    track_id: str
    start_ms: int
    end_ms: int
    title: str | None = None

    def to_domain(self) -> FocusFragment:
        return FocusFragment(
            track_id=self.track_id,
            start_ms=self.start_ms,
            end_ms=self.end_ms,
            title=self.title,
        )


class UserContextDto(BaseModel):
    current_track_id: str | None = None
    now: str | None = None  # ISO-8601 with offset, device local time
    recent_tracks: list[UserContextTrackDto] = Field(
        default_factory=list, max_length=20,
    )
    focus: FocusFragmentDto | None = None

    def to_domain(self) -> UserContext:
        return UserContext(
            current_track_id=self.current_track_id,
            now=_parse_iso(self.now),
            recent_tracks=tuple(t.to_domain() for t in self.recent_tracks),
            focus=self.focus.to_domain() if self.focus else None,
        )


class ChatMessageDto(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequestDto(BaseModel):
    messages: list[ChatMessageDto] = Field(min_length=1)
    lang: Literal["ru", "en"] = "ru"
    user_context: UserContextDto | None = None


def _parse_iso(s: str | None) -> datetime | None:
    """Parse ISO-8601 with offset (e.g. '2026-05-17T19:42:00+03:00').

    Returns None for None / empty / malformed input — the domain treats
    missing timestamps as "unknown" rather than raising on the boundary;
    the mobile client should always send a value, and a parse miss is
    not worth failing the whole request over.
    """
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None
