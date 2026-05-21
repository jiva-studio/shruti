"""Extract deictic-resolvable refs from the prior turn's assistant
message.

`fold_history` strips `[card:track_X]` / `[cite:track_X@s-e]` /
`[verse:src/tokens]` markers from what the LLM sees on subsequent
turns — that's the right anti-poisoning behaviour. But follow-up
actions and queries often refer back to those refs deictically
(«PDF этих лекций», «перескажи эту», «комментарий к этому стиху»),
so workers that need to resolve such references read the RAW prior
content via this helper.

Use this BEFORE `fold_history` strips the markers — `state["history"]`
holds the raw client-sent content, which is the right input.
"""

from __future__ import annotations

import re
from typing import Any


# Track-shaped refs: `[card:track_X]` and `[cite:track_X@s-e]`.
# Both yield the bare catalog track_id (group 1).
_TRACK_REF_RE = re.compile(
    r"\[(?:card|cite):([A-Za-z0-9_.-]+)(?:@|\])"
)


def extract_prior_track_refs(history: list[dict[str, Any]] | None) -> list[str]:
    """Scan the most recent assistant message in `history` for track
    refs embedded in `[card:X]` / `[cite:X@s-e]` markers. Returns the
    list of catalog track_ids in first-seen order, deduplicated.

    Returns an empty list when there's no prior assistant message or
    the message had no track-shaped markers.
    """
    last_assistant = ""
    for m in reversed(history or []):
        if m.get("role") == "assistant":
            last_assistant = m.get("content") or ""
            break
    if not last_assistant:
        return []

    seen: set[str] = set()
    out: list[str] = []
    for match in _TRACK_REF_RE.finditer(last_assistant):
        tid = match.group(1)
        if tid in seen:
            continue
        seen.add(tid)
        out.append(tid)
    return out
