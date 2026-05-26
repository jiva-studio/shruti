"""HTTP DTOs for POST /chat.

Wire shape stays string-based for timestamps (ISO-8601 with offset) so
mobile parsing is unchanged. The `to_domain` helpers convert into the
typed domain entities (`UserContext`, `FocusFragment`, ...).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from lectorium_chat.domain.user_context import (
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


class ChunkAliasDto(BaseModel):
    """One row of the integer-alias map the server minted while answering
    a prior turn. The client persists this alongside the assistant
    message (in its versioned-meta JSON) and ships it back when sending
    the next turn's history. The server uses it to re-substitute
    `[cite:track_X@start-end|caption]` markers in that message's prose
    back into `[^N]` form so the LLM sees one consistent
    numbered-ref format throughout the history."""

    track_id: str
    start_ms: int | None = None
    end_ms: int | None = None


class ChatMessageDto(BaseModel):
    role: Literal["user", "assistant"]
    # Cap on user message size — bounds prompt cost and mitigates trivial
    # DoS via giant payloads. 4000 chars comfortably exceeds the longest
    # legitimate question we've seen in production.
    content: str = Field(..., max_length=4000)
    # Server-minted integer aliases for the chip markers in `content`.
    # Keys are integers serialised as strings (JSON limitation); values
    # describe the catalog reference each alias points to. Only present
    # on assistant turns and only if the client persisted what the
    # server sent on the `aliases` event for that turn. Legacy
    # assistant messages (before this protocol) have it absent; the
    # server falls back to stripping their chip markers to placeholder
    # text.
    aliases: dict[str, ChunkAliasDto] | None = Field(default=None, max_length=128)


# Proactive-rule context — opaque JSON dict. Each rule kind has its own
# expected shape (weekly_digest, inactivity, holiday); the per-rule
# prompt builder is responsible for asserting required keys. Keeping
# the wire shape loose lets us add new rules without a schema bump.
ProactiveRuleKind = Literal["weekly_digest", "inactivity", "holiday"]


class ProactiveRequestDto(BaseModel):
    """When set, the chat endpoint swaps the system prompt for a
    rule-specific builder. `messages` is ignored apart from optional
    trailing assistant placeholders — the builder synthesises the
    user message from `rule_context`."""

    rule_kind: ProactiveRuleKind
    rule_date: str  # 'YYYY-MM-DD' — for logging / dedup at the edge
    rule_context: dict = Field(default_factory=dict)


class ChatRequestDto(BaseModel):
    messages: list[ChatMessageDto] = Field(min_length=1, max_length=20)
    lang: Literal["ru", "en"] = "ru"
    user_context: UserContextDto | None = None
    proactive: ProactiveRequestDto | None = None
    # Client-managed chat session — groups turns of the same conversation
    # in Langfuse Sessions. `session_id` is the local chat_sessions row PK
    # (TEXT primary key) on the mobile side; `session_title` is the
    # user-visible session title (derived first turn, optionally
    # LLM-rephrased afterwards). Both optional — turns without a session
    # context (e.g. one-off API calls) still trace.
    session_id: str | None = None
    session_title: str | None = None


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
