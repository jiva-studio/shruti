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

from lectorium_chat.agent.turn_aliases import ChunkRef, TurnAliasMap, VerseRef
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


# The ONLY marker the LLM emits is `[ref:N]` (or `[ref:N|caption]` —
# caption is optional and only used when alias N is a lecture fragment).
# Server routes by alias type:
#   ChunkRef + start_ms/end_ms → [cite:track_X@start-end|caption?]   audio fragment
#   ChunkRef without start/end → [card:track_X]                       whole-track card
#   VerseRef                   → [verse:src/tokens|addr_label]        verse widget
# The LLM never picks the client-side marker type itself.
_REF_RE = re.compile(r"^\[ref:(\d+)(?:\|([^\]]*))?\]$")

# Markers that are NOT consumed by MarkerExpander but ARE part of our
# wire protocol — must pass through verbatim. The client (mobile / web)
# handles them downstream.
_PASSTHROUGH_MARKER_PREFIXES = ("[action:", "[followup:")

# Bracketed `[word:...]` markers we KNOW the LLM hallucinates by analogy
# with verse/cite. Document-kind chunks (commentary / prose_chapter /
# letter) MUST be quoted inline as markdown blockquotes per the prompt —
# they have NO citation marker. The LLM sometimes invents `[commentary:
# BG 2.13]` / `[purport:…]` / `[doc:…]` by analogy. Drop those silently
# so the user doesn't see raw bracket text on the screen. (We log so
# prompt regressions are noticed.)
_HALLUCINATED_DOC_MARKER_RE = re.compile(
    r"^\[(commentary|purport|prose_chapter|prose|letter|doc|document|book|chapter):[^\]]*\]$"
)

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
        # Track aliases we've ALREADY successfully expanded in this
        # response. Used by `_format_ref` to recover from a hallucinated
        # `[ref:N]` when exactly one valid alias is still unused — the
        # LLM "meant" the only one left.
        self._emitted: set[int] = set()

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
        # The ONLY marker form the LLM emits.
        m = _REF_RE.match(marker)
        if m:
            n_str, caption = m.group(1), (m.group(2) or "").strip()
            return self._format_ref(int(n_str), caption, marker)

        # Hallucinated bracket markers that LLM occasionally invents by
        # analogy with the documented protocol — drop silently + log so
        # prompt regressions are observable. Covers both pre-migration
        # markers (the LLM was trained to emit [cite:N|...] /
        # [verse:N|...] / [card:N] / [outline:N] in earlier versions and
        # MAY still produce them) and document-kind hallucinations
        # ([commentary:BG 2.13], [purport:…], etc.).
        if _HALLUCINATED_DOC_MARKER_RE.match(marker) or marker.startswith(
            ("[cite:", "[card:", "[outline:", "[verse:")
        ):
            log.info(
                "chat_marker_legacy_or_hallucinated_dropped",
                request_id=self._request_id,
                marker=marker[:80],
            )
            return ""

        # Anything else (action markers, followup markers, plain
        # bracketed text) — pass through untouched.
        return marker

    def _format_ref(self, n: int, caption: str, original: str) -> str:
        """Resolve alias N and emit the client-side marker matching the
        ref's shape. Verses → [verse:src/tokens|label]; lecture
        fragments → [cite:track@start-end|caption?]; whole-track refs
        (ChunkRef without start/end) → [card:track]. Caption from the LLM
        is used only for lecture fragments — verses always use their
        addr_label, and cards have no caption.

        If N is unknown but exactly ONE valid alias remains unused in
        this response, the LLM had a single valid candidate left — we
        substitute it. With sequential aliases [1..K] this is a strong
        signal: hallucinated 4-digit refs like `[ref:1022]` get pinned
        back to the right note when only one slot is open."""
        ref = self._aliases.resolve(n)

        # Hallucinated alias — attempt recovery before dropping.
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

        self._emitted.add(n)

        if isinstance(ref, VerseRef):
            body = f"{ref.source_id}/{ref.tokens}"
            # Use the curator-stored addr_label as caption; ignore any
            # LLM-supplied caption to keep verse citations consistent.
            label = ref.addr_label or caption or ""
            return f"[verse:{body}|{label}]" if label else f"[verse:{body}]"

        if isinstance(ref, ChunkRef):
            if ref.start_ms is not None and ref.end_ms is not None:
                # Lecture audio fragment.
                body = f"{ref.track_id}@{ref.start_ms}-{ref.end_ms}"
                return f"[cite:{body}|{caption}]" if caption else f"[cite:{body}]"
            # Whole-track card (no playhead position).
            return f"[card:{ref.track_id}]"

        # Resolved to something that's not Chunk/Verse — should be
        # impossible given AliasRef union, but stay defensive.
        return ""
