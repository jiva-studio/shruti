"""HTTP DTOs for POST /chat.

Wire shape stays string-based for timestamps (ISO-8601 with offset) so
mobile parsing is unchanged. The `to_domain` helpers convert into the
typed domain entities (`UserContext`, `FocusFragment`, ...).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    numbered-ref format throughout the history.

    `TurnAliasMap.serialize()` emits SEVERAL shapes discriminated by an
    optional `kind`: the default track/chunk row (carries `track_id`),
    plus `verse` / `chapter` / `media` / `commentary` rows that carry
    their own ids (`source_id`, `item_id`, …) and **no** `track_id`. We
    accept all of them permissively — extra per-kind fields ride through
    via `extra="allow"` and `TurnAliasMap.load_external` re-validates each
    entry by kind. The DTO's only jobs are to bound the map size and
    confirm each value is an object. (Before this was widened, replaying a
    turn that cited a verse or commentary 422'd on the missing
    `track_id`.)"""

    model_config = ConfigDict(extra="allow")

    kind: str | None = None
    track_id: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None


USER_CONTENT_MAX = 4000
# Assistant turns are server-generated prose with citations and routinely
# exceed the user cap; the client replays them verbatim in history. We still
# bound them to keep a single message from blowing up the prompt, just far
# higher than a user question would ever be.
ASSISTANT_CONTENT_MAX = 32000


class ChatMessageDto(BaseModel):
    role: Literal["user", "assistant"]
    # Hard ceiling enforced by the schema; the role-specific cap below is the
    # one that matters in practice.
    content: str = Field(..., max_length=ASSISTANT_CONTENT_MAX)
    # Server-minted integer aliases for the chip markers in `content`.
    # Keys are integers serialised as strings (JSON limitation); values
    # describe the catalog reference each alias points to. Only present
    # on assistant turns and only if the client persisted what the
    # server sent on the `aliases` event for that turn. Legacy
    # assistant messages (before this protocol) have it absent; the
    # server falls back to stripping their chip markers to placeholder
    # text.
    aliases: dict[str, ChunkAliasDto] | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def _cap_user_content(self) -> "ChatMessageDto":
        # The 4000-char cap is meant to bound a user *question*. Applying it to
        # assistant turns rejects the server's own prior replies on the next
        # turn, breaking multi-turn conversations.
        if self.role == "user" and len(self.content) > USER_CONTENT_MAX:
            raise ValueError(
                f"String should have at most {USER_CONTENT_MAX} characters"
            )
        return self


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


class ChatTurnConfigDto(BaseModel):
    """Per-turn experimental tweaks for ad-hoc A/B comparisons without
    rebuilding the image. All fields default to "no change" so a client
    that doesn't send `config` (or sends `null`) gets the production
    path verbatim.

    Adding a new toggle:
      1. Add a Pydantic field here defaulting to the production value
         (e.g. `enable_stage2: bool = True`).
      2. Read it in the node that cares:
         `state.get("config", {}).get("enable_stage2", True)`.

    Defaults always reflect prod behaviour so omitting the field gives
    the prod path. Bool toggles only — no nested DTOs. Document each
    field with WHY it exists; most we'll delete after the experiment.
    """

    # When False, the synthesis_planner node returns `outline=None`
    # immediately so the synthesizer runs free-form over all notes
    # (legacy pre-#716 behaviour). Used to compare structured vs
    # free-form prose on the same retrieval.
    enable_planner: bool = True

    # When False, the cross-encoder reranker is bypassed in BOTH Stage A
    # (fanout pool ordering) and Stage B (per-thesis grounding) so the
    # pipeline runs the bi-encoder cosine path. Default True. Per-turn
    # kill-switch for eval A/B against the cosine baseline.
    enable_reranker: bool = True

    # When False, the synthesis_planner does NOT stream the planner-written
    # intro early (right after build_outline, before Stage 1/2); the
    # synthesizer renders the intro itself at the front of the stream as
    # before. Default True — early paint cuts perceived time-to-first-token.
    enable_early_intro: bool = True


class ChatRequestDto(BaseModel):
    messages: list[ChatMessageDto] = Field(min_length=1, max_length=20)
    # Opaque locale code (e.g. "ru", "en", "uk", "sr-Latn", "sr-Cyrl"). The
    # backend does NOT hardcode the language set: `lang` drives the answer
    # prose / planner directly, and whether a corpus language exists for it
    # is decided from `distinct_langs()` at retrieval time (see
    # research.pipeline). A request that omits `lang` gets English.
    lang: str = "en"
    # When true, verbatim citations (transcripts, verse translations,
    # commentary, media, chapter titles) with no native variant in `lang`
    # are LLM-translated into `lang` and shipped as a (shown, original, mt)
    # pair. Default off → such citations fall back to English (en-preferred),
    # never machine-translated.
    translate_citations: bool = False
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
    config: ChatTurnConfigDto | None = None
    # Client-declared render capabilities (Microsoft-Graph-style: the
    # client advertises what it can render, the server conditionally
    # adapts the response). Additive + backward-compatible: an omitted /
    # empty map means "legacy client" → the server keeps inlining content
    # it would otherwise ship as a structured card. Current keys:
    #   "commentary_card" — client renders purport/commentary citations as
    #   a collapsible card (an `action.kind=commentary` payload + a
    #   `[commentary:…]` marker) instead of an inline markdown blockquote.
    # Unknown keys are ignored; do NOT bump X-Chat-Protocol-Version for new
    # capabilities (that would 426 every deployed client).
    capabilities: dict[str, bool] = Field(default_factory=dict)


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
