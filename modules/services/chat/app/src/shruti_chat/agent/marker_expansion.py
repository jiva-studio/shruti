"""What a closed marker expands to: alias → client widget, and the checks a
marker the model typed out itself must pass before it reaches the client.

Server-side expansion (alias type → client widget):
  ChunkRef + start_ms/end_ms → [cite:track_X@start-end|caption?]   audio
  ChunkRef without start/end → [card:track_X]                       card
  VerseRef                   → [verse:src/tokens|addr_label]        verse
  MediaRef                   → [media:item_id|caption]              media clip
  ChapterRef                 → [chapter:src/region|label]           chapter
"""

from __future__ import annotations

from typing import Any, NamedTuple

from shruti_chat.agent.marker_tokens import (
    ACTION_ID_RE,
    CARD_REF_RE,
    OUTLINE_ID_RE,
    STRICT_PATTERNS,
)
from shruti_chat.agent.turn_aliases import (
    ChapterRef,
    ChunkRef,
    MediaRef,
    TurnAliasMap,
    VerseRef,
)


class BypassVerdict(NamedTuple):
    """Whether a typed-out marker passes; when it does not, the log event
    and fields that say why."""

    keep: bool
    event: str = ""
    fields: dict[str, Any] | None = None


def check_bypass_marker(
    marker: str,
    *,
    aliases: TurnAliasMap,
    emitted_action_ids: set[str] | None,
    emitted_outline_ids: set[str] | None,
) -> BypassVerdict:
    """A keyword bracket the model wrote itself instead of `[^N]`.

    It passes verbatim only when it matches its strict per-kind grammar AND
    names something that exists this turn. LLM hallucinations like
    `[cite:track_X@notanumber-...]`, typos like `[citataion:...]` or
    unclosed `[verse:` would surface as visible garbage inside the bubble.
    `None` id sets (tests / turns without actions or outlines) skip the
    grounding check for that kind.
    """
    for pattern in STRICT_PATTERNS:
        if not pattern.match(marker):
            continue
        # Action markers carry an `id=` that must correspond to an `action`
        # SSE event actually emitted this turn — otherwise the client renders
        # an orphan «Карточка повреждена».
        am = ACTION_ID_RE.match(marker)
        if am is not None and emitted_action_ids is not None:
            if am.group(1) not in emitted_action_ids:
                return BypassVerdict(False, "chat_action_marker_orphan_dropped", {
                    "action_id": am.group(1),
                    "emitted": sorted(emitted_action_ids),
                })
        # Verse/chapter cards: legit ones arrive via `[^N]` expansion, so a
        # raw one must match a turn alias.
        cm = CARD_REF_RE.match(marker)
        if cm is not None and not aliases.has_verse_or_chapter(cm.group(1), cm.group(2)):
            return BypassVerdict(False, "chat_card_marker_ungrounded_dropped", {
                "marker": marker[:120],
            })
        # Outline cards: a track that never produced an outline this turn
        # would mount an empty no-op card on the client.
        om = OUTLINE_ID_RE.match(marker)
        if om is not None and emitted_outline_ids is not None:
            if om.group(1) not in emitted_outline_ids:
                return BypassVerdict(False, "chat_outline_marker_ungrounded_dropped", {
                    "track_id": om.group(1),
                    "emitted": sorted(emitted_outline_ids),
                })
        return BypassVerdict(True)
    return BypassVerdict(False, "chat_marker_malformed_dropped", {"marker": marker[:120]})


def alias_marker(ref: Any, n: int, captions: dict[int, str]) -> tuple[str | None, str]:
    """`(card family to queue, marker)` for a resolved non-commentary alias.

    The family keys the `_worker_common.CARD_SPECS` registry the synthesizer
    bridge dispatches on; None when the widget has no card payload. An alias
    of an unknown type expands to nothing.
    """
    if isinstance(ref, VerseRef):
        body = f"{ref.source_id}/{ref.tokens}"
        label = ref.addr_label or ""
        return "verse", (f"[verse:{body}|{label}]" if label else f"[verse:{body}]")

    if isinstance(ref, MediaRef):
        # Caption defaults to the server-built label ("speaker · date" /
        # title). The full playable payload (url + type + text) rides
        # ahead of this marker via the `media` SSE event; the marker
        # itself only carries the id the client keys on + a caption.
        caption = ref.label or ""
        media = f"[media:{ref.item_id}|{caption}]" if caption else f"[media:{ref.item_id}]"
        return "media", media

    if isinstance(ref, ChapterRef):
        body = f"{ref.source_id}/{ref.region_token}"
        label = ref.region_label or ""
        return "chapter", (f"[chapter:{body}|{label}]" if label else f"[chapter:{body}]")

    if isinstance(ref, ChunkRef):
        if ref.start_ms is not None and ref.end_ms is not None:
            body = f"{ref.track_id}@{ref.start_ms}-{ref.end_ms}"
            caption = captions.get(n, "")
            return "cite", (f"[cite:{body}|{caption}]" if caption else f"[cite:{body}]")
        return None, f"[card:{ref.track_id}]"

    return None, ""
