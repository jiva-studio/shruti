"""Payloads queued while markers expand, drained before the delta that carries them.

The client renders a card only when its payload arrived first, so every
payload queued here is written to the SSE stream by the synthesizer just
before the delta that carries its marker.
"""

from __future__ import annotations

from typing import NamedTuple

from shruti_chat.agent.turn_aliases import ChapterRef, ChunkRef, MediaRef, VerseRef

# The alias ref behind an auto-render card. Each maps to one CARD_SPECS entry.
CardRef = VerseRef | ChunkRef | MediaRef | ChapterRef


class CardRequest(NamedTuple):
    """One auto-render card queued for lazy synth-time emit.

    `family` keys the `_worker_common.CARD_SPECS` registry the synthesizer
    bridge dispatches on; `ref_num` is the alias number (needed by the cite
    builder for its stashed transcript text); `ref` is the alias ref."""

    family: str
    ref_num: int
    ref: CardRef


class MarkerOutbox:
    """Card requests (card-capable clients only) and commentary `action`
    envelopes, each taken — and cleared — by the synthesizer."""

    def __init__(self, *, lazy_cards: bool) -> None:
        # Card-capable clients get auto-render cards (verse / cite / media /
        # chapter) built at synth time, cited-only; other clients get every
        # aliased card up front from `flush_card_payloads`, so nothing is
        # queued for them.
        self._lazy_cards = lazy_cards
        self._card_requests: list[CardRequest] = []
        self._commentary_actions: list[dict] = []

    def queue_card(self, family: str, ref_num: int, ref: CardRef) -> None:
        if self._lazy_cards:
            self._card_requests.append(CardRequest(family, ref_num, ref))

    def queue_commentary_action(self, action: dict) -> None:
        self._commentary_actions.append(action)

    def take_card_requests(self) -> list[CardRequest]:
        if not self._card_requests:
            return []
        out = self._card_requests
        self._card_requests = []
        return out

    def take_commentary_actions(self) -> list[dict]:
        if not self._commentary_actions:
            return []
        out = self._commentary_actions
        self._commentary_actions = []
        return out
