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
    """Walk `history` backwards through assistant messages and return
    the track refs from the FIRST one that contains any. Returns
    catalog track_ids in document order, deduplicated.

    Walking backwards-until-found (rather than just reading the
    single last assistant message) handles long conversations where
    the user said "thanks" / "ok" between the card stack and the
    deictic follow-up — the immediate last assistant turn may be a
    plain ack with no refs. We want the most recent turn that
    actually surfaced tracks the user can point at.
    """
    if not history:
        return []

    for m in reversed(history):
        if m.get("role") != "assistant":
            continue
        content = m.get("content") or ""
        if not isinstance(content, str) or not content:
            continue
        seen: set[str] = set()
        out: list[str] = []
        for match in _TRACK_REF_RE.finditer(content):
            tid = match.group(1)
            if tid in seen:
                continue
            seen.add(tid)
            out.append(tid)
        if out:
            return out
    return []
