"""Stream-side marker expander for the numbered-refs protocol.

The model writes `[cite:N|caption]` / `[card:N]` / `[outline:N]` in
its prose where `N` is an integer alias minted by `TurnAliasMap`.
This filter sits between the LLM stream and the client SSE stream:
when a marker closes (we see `]`), look up `N`, expand to the real
`[cite:track_X@start-end|caption]` (or drop if `N` is unknown), then
forward.

Tokens between markers stream through with effectively zero overhead.
The buffer only holds the in-flight marker — usually under 30 chars.
"""

from __future__ import annotations

import re

from shruti_chat.agent.turn_aliases import ChunkRef, TurnAliasMap, VerseRef
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


# A complete marker in the form we accept from the LLM. The integer
# ref captures `N`; an optional `|caption` tail captures the chip
# label. Cards / outlines have no caption.
_CITE_RE    = re.compile(r"^\[cite:(\d+)(?:\|([^\]]*))?\]$")
_CARD_RE    = re.compile(r"^\[card:(\d+)\]$")
_OUTLINE_RE = re.compile(r"^\[outline:(\d+)\]$")
_VERSE_RE   = re.compile(r"^\[verse:(\d+)(?:\|([^\]]*))?\]$")

# If buffering grows past this with no closing `]`, it's clearly not a
# marker — flush as plain text.
_MAX_BUFFER = 200


class MarkerExpander:
    """Per-stream state machine. Hold tokens between `[` and `]`,
    parse the buffer as a numbered-refs marker, expand or drop, then
    forward."""

    def __init__(
        self,
        aliases: TurnAliasMap,
        *,
        request_id: str | None = None,
    ) -> None:
        self._aliases = aliases
        self._request_id = request_id
        self._buffer: list[str] = []
        self._in_marker = False

    async def feed(self, text: str) -> str:
        """Process a delta chunk; returns what should be forwarded."""
        out: list[str] = []
        for ch in text:
            if not self._in_marker:
                if ch == "[":
                    self._in_marker = True
                    self._buffer = ["["]
                else:
                    out.append(ch)
                continue
            self._buffer.append(ch)
            if ch == "]":
                marker = "".join(self._buffer)
                out.append(self._expand_marker(marker))
                self._buffer = []
                self._in_marker = False
            elif len(self._buffer) > _MAX_BUFFER:
                # Not a marker at all — flush as plain text.
                out.append("".join(self._buffer))
                self._buffer = []
                self._in_marker = False
        return "".join(out)

    async def flush(self) -> str:
        """Drain any partial-marker tail at stream end."""
        if not self._buffer:
            return ""
        tail = "".join(self._buffer)
        self._buffer = []
        self._in_marker = False
        return tail

    def _expand_marker(self, marker: str) -> str:
        # cite — has integer ref + optional caption
        m = _CITE_RE.match(marker)
        if m:
            n_str, caption = m.group(1), (m.group(2) or "").strip()
            return self._format_cite(int(n_str), caption, marker)
        # card — integer ref, no caption
        m = _CARD_RE.match(marker)
        if m:
            return self._format_card(int(m.group(1)), marker)
        # outline — integer ref, no caption
        m = _OUTLINE_RE.match(marker)
        if m:
            return self._format_outline(int(m.group(1)), marker)
        # verse — integer ref + optional caption (library widget)
        m = _VERSE_RE.match(marker)
        if m:
            n_str, caption = m.group(1), (m.group(2) or "").strip()
            return self._format_verse(int(n_str), caption, marker)
        # Not a numbered-ref marker. Could be `[action:...]` (we leave
        # those for the client), or stray brackets in prose, or a
        # malformed/hallucinated chip marker (e.g. `[cite:track_X|...]`,
        # `[cite:BG_1972_03.05|...]`) — drop those, log, and emit
        # nothing in their place so the surrounding prose stays clean.
        if marker.startswith(("[cite:", "[card:", "[outline:", "[verse:")):
            log.info(
                "chat_marker_non_integer_dropped",
                request_id=self._request_id,
                marker=marker[:80],
            )
            return ""
        # Anything else (action markers, plain bracketed text) — pass
        # through untouched.
        return marker

    def _format_cite(self, n: int, caption: str, original: str) -> str:
        ref = self._aliases.resolve(n)
        if not isinstance(ref, ChunkRef) or ref.start_ms is None or ref.end_ms is None:
            log.info(
                "chat_marker_alias_miss",
                request_id=self._request_id,
                kind="cite",
                ref=n,
                known_max=len(self._aliases),
            )
            return ""
        body = f"{ref.track_id}@{ref.start_ms}-{ref.end_ms}"
        return f"[cite:{body}|{caption}]" if caption else f"[cite:{body}]"

    def _format_card(self, n: int, original: str) -> str:
        ref = self._aliases.resolve(n)
        if not isinstance(ref, ChunkRef):
            log.info(
                "chat_marker_alias_miss",
                request_id=self._request_id,
                kind="card",
                ref=n,
                known_max=len(self._aliases),
            )
            return ""
        return f"[card:{ref.track_id}]"

    def _format_outline(self, n: int, original: str) -> str:
        ref = self._aliases.resolve(n)
        if not isinstance(ref, ChunkRef):
            log.info(
                "chat_marker_alias_miss",
                request_id=self._request_id,
                kind="outline",
                ref=n,
                known_max=len(self._aliases),
            )
            return ""
        return f"[outline:{ref.track_id}]"

    def _format_verse(self, n: int, caption: str, original: str) -> str:
        ref = self._aliases.resolve(n)
        if not isinstance(ref, VerseRef):
            log.info(
                "chat_marker_alias_miss",
                request_id=self._request_id,
                kind="verse",
                ref=n,
                known_max=len(self._aliases),
            )
            return ""
        body = f"{ref.source_id}/{ref.tokens}"
        return f"[verse:{body}|{caption}]" if caption else f"[verse:{body}]"
