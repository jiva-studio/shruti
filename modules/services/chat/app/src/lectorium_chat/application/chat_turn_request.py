"""ChatTurnRequest — everything one chat turn is asked to do.

The DATA a turn works on, as one value object; the COLLABORATORS it works
through — the composition root's `AppDeps` and the disconnect probe — stay
separate arguments to `run_chat_turn`. That split is the point: `deps` is
wiring, this is the request. It also gives related fields somewhere to sit
together: `tier` and `tier_expires_at` are two halves of one claim and mean
nothing apart, which is why `effective_tier` lives here.

Three groups, with different origins and different trust:

- what was asked: the replayed conversation, the app's locale, the client's
  attribute aggregate, its render capabilities, the per-turn config toggles,
  and the on-device listening snapshot. Client-supplied.
- who is asking: the verified JWT claims that gate Pro capabilities and the raw
  token the ingest path re-verifies. Trusted — never taken from the request
  body.
- correlation: the ids that stitch this turn to its logs, its Langfuse trace,
  and the feedback the user may leave on it later.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from lectorium_chat.domain.user_context import UserContext


@dataclass(frozen=True)
class ChatTurnRequest:
    # ── what was asked ────────────────────────────────────────────────────
    # The conversation as the client replayed it, oldest first. Capped
    # upstream (`ChatRequestDto.messages`, max 20), which is exactly why
    # `client_attributes` exists.
    history: list[dict[str, Any]] = field(default_factory=list)
    # Opaque locale code from the app's settings. Only a HINT about the answer
    # language — what actually decides it is settled per turn from the message
    # (see `domain/conversation_attributes.py`).
    lang: str = "en"
    # Conversation attributes as the CLIENT aggregated them over its full local
    # history. Preferred over folding the replayed messages: the client saw the
    # whole dialogue, this request only sees the tail of it.
    client_attributes: dict[str, Any] | None = None
    # What the client can render (e.g. {"commentary_card": True}). Empty ⇒
    # legacy client ⇒ the server inlines what it would otherwise ship as cards.
    capabilities: dict[str, bool] | None = None
    # Opt-in to machine-translating verbatim citations that have no native
    # variant in `lang`. Off ⇒ such citations fall back to English.
    translate_citations: bool = False
    # Per-turn experimental toggles (`ChatTurnConfigDto`). Empty ⇒ prod path.
    turn_config: dict[str, Any] | None = None
    # On-device listening snapshot: what is playing, what was played, and the
    # transcript fragment an "Ask Sadhu" turn is anchored to.
    user_context: UserContext | None = None

    # ── who is asking ─────────────────────────────────────────────────────
    # Verified JWT claims. `tier_expires_at` is UNIX epoch, 0 = no claim; the
    # two are only meaningful together, which is what `effective_tier` is for.
    tier: str = "free"
    tier_expires_at: int = 0
    # The raw bearer token, carried so the ingest worker can re-verify it and
    # act on the user's behalf (add-to-library).
    jwt: str | None = None

    # ── correlation ───────────────────────────────────────────────────────
    request_id: str | None = None
    session_id: str | None = None
    session_title: str | None = None
    # The turn's resolved trace id, 32 hex chars: the client's
    # assistant-message id when it sent one (validated upstream), otherwise a
    # server-minted fallback. Becomes the Langfuse trace id so a later
    # `/chat/feedback` POST about that message lands on the right trace.
    #
    # Resolved by the CALLER, not here: `api/chat.py` already mints the
    # fallback to key the turn buffer, and a second `or uuid4().hex` in
    # `run_chat_turn` produced a DIFFERENT id for the same turn whenever the
    # client sent no `X-Trace-Id` — leaving the resume buffer and the Langfuse
    # trace impossible to correlate. One turn, one id.
    trace_id: str | None = None

    def effective_tier(self, now: int) -> str:
        """`tier`, with a lapsed Pro claim coerced back to free.

        Auth can mint `tier="pro"` with an expiry already in the past — a
        dropped RevenueCat EXPIRATION webhook. Such a claim must not unlock a
        Pro-only capability, so it is coerced BEFORE the tier reaches any graph
        gate. Mirrors `application/rate_limiter._user_limit_for`. `now` is
        passed in rather than read so the rule stays pure and testable.
        """
        if self.tier == "pro" and self.tier_expires_at != 0 and self.tier_expires_at < now:
            return "free"
        return self.tier

    def latest_user_query(self) -> str:
        """The current question, i.e. the last user message.

        The router and the workers read this alone — threading the whole
        conversation into their inner LLM calls buys nothing. The synthesizer
        is the exception and gets `history` folded down to user-visible text.
        """
        for entry in reversed(self.history):
            if entry.get("role") == "user" and isinstance(entry.get("content"), str):
                return entry["content"]
        return ""
