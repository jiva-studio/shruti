"""The marker grammar: what a closed `[…]` token in the model's prose is.

The expander buffers characters between `[` and `]`; once a bracket closes,
these patterns decide whether it is a `[^N]` footnote, a string-stuffed
footnote, one of our client markers typed out by the model, or plain prose.
"""

from __future__ import annotations

import re

# `[^N]` with integer N, optionally `[^N|s=0,2,5]` for commentary
# blockquote sub-selection (sentence indices into the chunk body).
# The `|s=...` suffix is silently ignored when the alias resolves to
# a non-commentary ref (lecture / verse) so a stray suffix on a wrong
# ref type can't break the stream.
FOOTNOTE_RE = re.compile(r"^\[\^(\d+)(?:\|s=([0-9,]+))?\]$")

# Catch-all `[^anything]` — non-integer string-stuffed hallucination.
FOOTNOTE_CATCH_RE = re.compile(r"^\[\^[^\]]*\]$")

# Bracket whose first token is one of our six marker keywords. The LLM
# only writes `[^N]` for citations — anything matching this pattern in
# the raw prose is the BYPASS-PROTOCOL form (LLM wrote the expanded
# marker directly). Two sub-cases:
#   - matches the strict per-kind grammar → pass through verbatim,
#     bypass audit elsewhere logs it for prompt tuning;
#   - doesn't match strict (malformed payload like
#     `[cite:track_X@bad-format]`) → drop + count, so the client
#     never renders the garbage in the bubble.
# Any bracket whose first token is NOT one of the six marker keywords
# doesn't match this and passes through verbatim.
KEYWORD_BRACKET_RE = re.compile(
    r"^\[(?:cite|card|outline|verse|chapter|media|commentary|action|followup)[:|]"
)
STRICT_PATTERNS = (
    re.compile(r"^\[cite:[A-Za-z0-9_.-]+@\d+-\d+(?:\|[^\]\n]*)?\]$"),
    re.compile(r"^\[card:[A-Za-z0-9_.-]+\]$"),
    re.compile(r"^\[outline:[A-Za-z0-9_.-]+\]$"),
    re.compile(r"^\[verse:[A-Za-z0-9_]+/[0-9.,-]+(?:\|[^\]\n]*)?\]$"),
    re.compile(r"^\[chapter:[A-Za-z0-9_]+/[0-9.,-]+(?:\|[^\]\n]*)?\]$"),
    re.compile(r"^\[media:[A-Za-z0-9_.-]+(?:\|[^\]\n]*)?\]$"),
    # commentary: just the numeric citation ref — text + meta ride in the
    # `action` payload (audio-citation shape), nothing else in the marker.
    re.compile(r"^\[commentary:\d+\]$"),
    re.compile(r"^\[action:[a-z][a-z0-9_]*\|id=[A-Za-z0-9_-]+\]$"),
    re.compile(r"^\[followup:[^\]|\n]+\]$"),
)

# Extracts the `id=` slot from a grammar-valid action marker so we can
# validate it against the set of action ids that actually fired this
# turn. A marker that's grammar-valid but carries an id no propose_* /
# pdf tool minted is a hallucination — it is DROPPED so the client never
# renders the orphan as «Карточка повреждена».
ACTION_ID_RE = re.compile(r"^\[action:[a-z][a-z0-9_]*\|id=([A-Za-z0-9_-]+)\]$")

# Extracts (source_id, tokens) from a grammar-valid bypass verse/chapter marker.
# A legit verse/chapter card always reaches the client via `[^N]` alias
# expansion; a raw `[verse:src/tokens]` the model TYPED is only legitimate when
# that ref was actually surfaced this turn. One typed for content never
# retrieved is a hallucination (e.g. prose «глава 16, стихи 4-18» with the
# marker `[verse:…/17.16]`) — validate against the alias map, DROP if absent.
CARD_REF_RE = re.compile(
    r"^\[(?:verse|chapter):([A-Za-z0-9_]+)/([0-9.,-]+)(?:\|[^\]\n]*)?\]$"
)

# Extracts the track_id from a grammar-valid `[outline:track_X]` marker.
# An outline card is legit only when `track_outline_get` actually ran for
# that track this turn (it emits an `action` event with the items the card
# renders). A marker for a track the turn never produced an outline for is
# a hallucination — the client would mount an empty interactive list (a
# silent no-op card). Validate against the set of grounded outline ids,
# mirroring the action-id grounding check; DROP if absent.
OUTLINE_ID_RE = re.compile(r"^\[outline:([A-Za-z0-9_.-]+)\]$")

# Runaway buffer cap — if we don't see `]` after this many chars, it
# wasn't a marker.
MAX_BUFFER = 200

# Punctuation that should land BEFORE the expanded widget on swap.
TRAILING_PUNCT = ".,!?…:;"


def parse_footnote(marker: str) -> tuple[int, list[int] | None] | None:
    """`[^N]` / `[^N|s=…]` → (N, sentence indices or None); None otherwise.

    Stray empties and non-numeric noise in the `s=` list are skipped rather
    than failing the marker — a partial sub-selection beats no quote at all.
    """
    m = FOOTNOTE_RE.match(marker)
    if not m:
        return None
    sentence_indices: list[int] | None = None
    if m.group(2):
        sentence_indices = []
        for part in m.group(2).split(","):
            part = part.strip()
            if not part:
                continue
            try:
                sentence_indices.append(int(part))
            except ValueError:
                continue
    return int(m.group(1)), sentence_indices
