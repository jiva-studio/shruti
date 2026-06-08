"""Canonical regexes for the EXPANDED chip markers.

These match the post-expansion forms the server emits to the client
(`[cite:track@start-end|caption]`, `[card:track]`, `[outline:track]`,
`[verse:source/tokens|label]`) — the same grammar the mobile client
parses in `composables/chatMarkers.ts` / `useMarkerParser.ts`. Keep this
file and the client parser in lockstep.

This is the single source of truth for *detecting* expanded markers in
assistant text. Two consumers use it:

  - `application/chat_turn.py::_audit_bypass_markers` — flags markers the
    LLM typed directly in prose instead of going through the numbered
    `[^N]` protocol (logged to Loki for the bypass dashboards).
  - `observability/auto_scores.py` — counts cites, broken refs, and
    bypasses for the Langfuse trace scores.

NOT covered here: the inbound `[^N]` numbered-ref grammar and the
malformed-bracket detection — those live in `agent/marker_expander.py`,
the producer side, because they govern what the LLM is allowed to TYPE,
not what we emit.
"""

from __future__ import annotations

import re

# Capture groups are a superset usable by every consumer:
#   CITE_RE    → (track_id, start_ms, end_ms, caption?)
#   CARD_RE    → (track_id,)
#   OUTLINE_RE → (track_id,)
#   VERSE_RE   → (source_id, tokens, label?)
# Consumers that only need the track_id read group(1); the trailing
# groups are harmless to ignore.
CITE_RE = re.compile(r"\[cite:([A-Za-z0-9_.-]+)@(\d+)-(\d+)(?:\|([^\]\n]*))?\]")
CARD_RE = re.compile(r"\[card:([A-Za-z0-9_.-]+)\]")
OUTLINE_RE = re.compile(r"\[outline:([A-Za-z0-9_.-]+)\]")
VERSE_RE = re.compile(r"\[verse:([A-Za-z0-9_]+)/([0-9.,-]+)(?:\|([^\]\n]*))?\]")
# MEDIA_RE → (media_id, caption?). `[media:<id>|<caption>]` — a short
# video/audio clip card. id is the library media item_id (opaque
# alphanumeric / underscore / dot / dash); caption is free display text.
MEDIA_RE = re.compile(r"\[media:([A-Za-z0-9_.-]+)(?:\|([^\]\n]*))?\]")

# Standalone `[s=…]` sentence-suffix tokens. The `|s=N,…` payload is only
# legal as a SUFFIX inside `[^N|s=…]`; a bare `[s=0,1]` in finalised text
# is producer-side garbage the expander passed through as plain prose.
SENTENCE_MARKER_LEAK_RE = re.compile(r"\[s=[0-9,]+\]")
