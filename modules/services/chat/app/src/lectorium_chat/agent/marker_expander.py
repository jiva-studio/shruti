"""Stream-side marker expander for the footnote-refs protocol.

The model writes `[^N]` in its prose where `N` is a small sequential
integer alias minted by `TurnAliasMap`. This filter sits between the
LLM stream and the client SSE stream:

  1. Buffer characters between `[` and `]` to detect markers.
  2. When a marker closes, parse it:
       * `[^N]` with integer N           → expand by alias type
       * `[^anything]` (string-stuffed)  → recover via single-candidate
                                            heuristic or drop
       * legacy `[ref:...]` / `[cite:...]` etc → drop with log
  3. After emitting the expansion, peek look-ahead chars. If the next
     non-whitespace char is trailing punctuation (`.,!?…:;`) — swap
     order so the punctuation lands BEFORE the widget. LLMs habitually
     write `Текст [^1].` which renders ugly on the client; we want
     `Текст. [cite:...|caption]`.

Server-side expansion (alias type → client widget):
  ChunkRef + start_ms/end_ms → [cite:track_X@start-end|caption?]   audio
  ChunkRef without start/end → [card:track_X]                       card
  VerseRef                   → [verse:src/tokens|addr_label]        verse

Captions for audio fragments come from `TurnAliasMap.captions`,
populated by a background Flash-Lite call in `research.pipeline`. If
not ready when expanding → emit `[cite:track_X@start-end]` without
caption; the chip degrades gracefully.

State machine:
    out_buffer: pending whitespace between last non-ws emit and the
        next event (a marker open OR more non-ws). Held back so that
        if a marker opens, we can decide whether the whitespace
        belongs before the punctuation-swap or after.
    in_marker / marker_buffer: characters between `[` and `]`.
    pending_expansion / pending_pre_ws / pending_gap: an expanded
        marker waiting on look-ahead before being committed (so we
        can swap with a trailing `.`).
"""

from __future__ import annotations

import re

from lectorium_chat.agent.turn_aliases import ChunkRef, TurnAliasMap, VerseRef
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


# Strict `[^N]` with integer N only.
_FOOTNOTE_RE = re.compile(r"^\[\^(\d+)\]$")

# Catch-all `[^anything]` — non-integer string-stuffed hallucination.
_FOOTNOTE_CATCH_RE = re.compile(r"^\[\^[^\]]*\]$")

# Legacy marker forms from the pre-[^N] protocol — drop silently.
_LEGACY_RE = re.compile(
    r"^\[(?:ref|cite|card|outline|verse):[^\]]*\]$"
)

# Document-kind hallucinations like `[commentary:БГ 2.13]`.
_HALLUCINATED_DOC_MARKER_RE = re.compile(
    r"^\[(commentary|purport|prose_chapter|prose|letter|doc|document|book|chapter):[^\]]*\]$"
)

# Runaway buffer cap — if we don't see `]` after this many chars, it
# wasn't a marker.
_MAX_BUFFER = 200

# Punctuation that should land BEFORE the expanded widget on swap.
_TRAILING_PUNCT = ".,!?…:;"


class MarkerExpander:
    """Per-stream state machine. Held state: marker buffer between
    `[…]`, pending-expansion awaiting punctuation look-ahead, and a
    short whitespace hold so we can drop the space before `[^…]` when
    we end up swapping the marker with a following punctuation."""

    def __init__(
        self,
        aliases: TurnAliasMap,
        *,
        request_id: str | None = None,
    ) -> None:
        self._aliases = aliases
        self._request_id = request_id

        # Marker-buffer state.
        self._marker_buffer: list[str] = []
        self._in_marker = False

        # Aliases successfully expanded so far — used by single-
        # candidate recovery in `_format_ref`.
        self._emitted: set[int] = set()

        # Pending whitespace seen after the last non-ws emit. May get
        # forwarded as-is (next char is non-ws or another marker) or
        # dropped (swap with trailing punctuation glues punct to the
        # prose, no leading whitespace needed).
        self._ws_hold: str = ""

        # Pending-expansion buffer: we expanded a marker but haven't
        # forwarded it yet because we're waiting on the next char to
        # decide swap-order. `_pre_ws` captures the whitespace that
        # was held when the `[` opened (we discard it on swap, restore
        # it on non-swap).
        self._pending: str | None = None
        self._pending_pre_ws: str = ""
        self._pending_gap: str = ""

    async def feed(self, text: str) -> str:
        """Process a delta chunk; returns what should be forwarded."""
        out: list[str] = []
        for ch in text:
            if self._in_marker:
                self._marker_buffer.append(ch)
                if ch == "]":
                    marker = "".join(self._marker_buffer)
                    self._marker_buffer = []
                    self._in_marker = False
                    expanded = self._expand_marker(marker)
                    self._on_marker_closed(expanded, out)
                elif len(self._marker_buffer) > _MAX_BUFFER:
                    # Not a marker — flush the runaway buffer as text.
                    runaway = "".join(self._marker_buffer)
                    self._marker_buffer = []
                    self._in_marker = False
                    out.append(self._consume_text(runaway))
                continue

            if ch == "[":
                # Whitespace held in _ws_hold STAYS held — we might
                # drop it on a swap, or restore it if no swap fires.
                self._in_marker = True
                self._marker_buffer = ["["]
                continue

            out.append(self._consume_text_char(ch))
        return "".join(out)

    async def flush(self) -> str:
        """Drain pending state at stream end."""
        out: list[str] = []
        if self._pending is not None:
            # No look-ahead arrived — emit pending without swap.
            out.append(self._pending_pre_ws + self._pending + self._pending_gap)
            self._pending = None
            self._pending_pre_ws = ""
            self._pending_gap = ""
        if self._ws_hold:
            out.append(self._ws_hold)
            self._ws_hold = ""
        if self._marker_buffer:
            # Unclosed `[…` at end of stream — emit raw.
            out.append("".join(self._marker_buffer))
            self._marker_buffer = []
            self._in_marker = False
        return "".join(out)

    # ── marker-closed dispatch ─────────────────────────────────────

    def _on_marker_closed(self, expanded: str, out: list[str]) -> None:
        """Bookkeeping when a `[…]` finishes parsing."""
        if not expanded:
            # Marker dropped (legacy / hallucinated / unrecovered).
            # Two normalisations to keep the prose clean:
            #   (a) discard `_ws_hold` — the whitespace that sat
            #       immediately before `[` belongs to the dropped
            #       marker and should not survive as extra spacing
            #   (b) if a pending expansion was waiting, flush it
            #       WITHOUT its trailing gap — the gap was the space
            #       between the pending marker and this just-dropped
            #       one. The next text's leading whitespace will act
            #       as the single separator.
            if self._pending is not None:
                out.append(self._pending_pre_ws + self._pending)
                self._pending = None
                self._pending_pre_ws = ""
                self._pending_gap = ""
            self._ws_hold = ""
            return

        # Successful expansion. If we already had a pending one, flush
        # it first (two markers in a row — second is the new pending).
        if self._pending is not None:
            out.append(self._pending_pre_ws + self._pending + self._pending_gap)
        self._pending = expanded
        self._pending_pre_ws = self._ws_hold
        self._pending_gap = ""
        self._ws_hold = ""

    # ── plain-text path ────────────────────────────────────────────

    def _consume_text(self, run: str) -> str:
        """Consume a multi-char text run (used when a runaway marker
        buffer is flushed back as text)."""
        return "".join(self._consume_text_char(ch) for ch in run)

    def _consume_text_char(self, ch: str) -> str:
        """Plain-text path. Coordinates with `_ws_hold` (whitespace
        held back in case a marker is about to open) and `_pending`
        (an expanded marker awaiting look-ahead)."""
        if self._pending is None:
            if ch.isspace():
                self._ws_hold += ch
                return ""
            # Non-whitespace: commit any held whitespace first.
            ws = self._ws_hold
            self._ws_hold = ""
            return ws + ch

        # Pending expansion exists — decide look-ahead.
        if ch.isspace():
            # Could still be the space before a trailing period.
            self._pending_gap += ch
            return ""

        if ch in _TRAILING_PUNCT:
            # Swap: punctuation glues to the prose, then a single
            # space, then the widget. We discard both the pre-marker
            # whitespace and the post-marker gap — neither belongs in
            # the swapped output.
            expansion = self._pending
            self._pending = None
            self._pending_pre_ws = ""
            self._pending_gap = ""
            return ch + " " + expansion

        # Non-punct, non-space → no swap. Commit pre_ws + expansion +
        # gap + ch.
        pre_ws = self._pending_pre_ws
        expansion = self._pending
        gap = self._pending_gap
        self._pending = None
        self._pending_pre_ws = ""
        self._pending_gap = ""
        return pre_ws + expansion + gap + ch

    # ── marker expansion ───────────────────────────────────────────

    def _expand_marker(self, marker: str) -> str:
        # Strict integer `[^N]`.
        m = _FOOTNOTE_RE.match(marker)
        if m:
            return self._format_ref(int(m.group(1)))

        # Non-integer footnote — try single-candidate recovery.
        if _FOOTNOTE_CATCH_RE.match(marker):
            log.info(
                "chat_marker_footnote_string_stuffed",
                request_id=self._request_id,
                marker=marker[:80],
            )
            return self._format_ref(None)

        # Legacy markers — drop with diagnostic.
        if _LEGACY_RE.match(marker):
            log.info(
                "chat_marker_legacy_dropped",
                request_id=self._request_id,
                marker=marker[:80],
            )
            return ""

        # Document-kind hallucinations — drop.
        if _HALLUCINATED_DOC_MARKER_RE.match(marker):
            log.info(
                "chat_marker_legacy_or_hallucinated_dropped",
                request_id=self._request_id,
                marker=marker[:80],
            )
            return ""

        # Anything else (action / followup / plain bracketed text) —
        # pass through. The held whitespace was already deferred but
        # will be flushed by the next text char.
        return marker

    def _format_ref(self, n: int | None) -> str:
        """Resolve alias N. If N is None or unknown, try single-
        candidate recovery (exactly one alias still unused → use it).
        Otherwise drop with diagnostic log.

        Deduplicates within a response: if the alias has already been
        emitted in this stream, drop the second+ occurrence silently.
        The prompt instructs the LLM to use each cite at most once;
        this is the server-side enforcement so any model slip-up
        doesn't produce spammy duplicate chips."""
        ref: ChunkRef | VerseRef | None = None
        if isinstance(n, int):
            # Dedup: if this exact alias has already been expanded in
            # this response, drop with log. Do this BEFORE recovery so
            # a "[^1] … [^1]" repeat doesn't accidentally recover to a
            # neighbouring unused alias.
            if n in self._emitted:
                log.info(
                    "chat_marker_dedup_dropped",
                    request_id=self._request_id,
                    ref=n,
                )
                return ""
            ref = self._aliases.resolve(n)

        if ref is None:
            remaining = self._aliases.known_keys() - self._emitted
            if len(remaining) == 1:
                recovered = next(iter(remaining))
                log.info(
                    "chat_marker_alias_recovered",
                    request_id=self._request_id,
                    requested=n,
                    recovered=recovered,
                    known_max=len(self._aliases),
                )
                n = recovered
                ref = self._aliases.resolve(n)
            else:
                log.info(
                    "chat_marker_alias_miss",
                    request_id=self._request_id,
                    kind="ref",
                    ref=n,
                    known_max=len(self._aliases),
                    emitted=sorted(self._emitted),
                    remaining=sorted(remaining),
                )
                return ""

        assert isinstance(n, int)
        self._emitted.add(n)

        if isinstance(ref, VerseRef):
            body = f"{ref.source_id}/{ref.tokens}"
            label = ref.addr_label or ""
            return f"[verse:{body}|{label}]" if label else f"[verse:{body}]"

        if isinstance(ref, ChunkRef):
            if ref.start_ms is not None and ref.end_ms is not None:
                body = f"{ref.track_id}@{ref.start_ms}-{ref.end_ms}"
                caption = self._aliases.captions.get(n, "")
                return f"[cite:{body}|{caption}]" if caption else f"[cite:{body}]"
            return f"[card:{ref.track_id}]"

        return ""
