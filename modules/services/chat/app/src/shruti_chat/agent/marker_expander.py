"""Stream-side marker expander for the footnote-refs protocol.

The model writes `[^N]` in its prose where `N` is a small sequential
integer alias minted by `TurnAliasMap`. This filter sits between the
LLM stream and the client SSE stream:

  1. Buffer characters between `[` and `]` to detect markers.
  2. When a marker closes, parse it:
       * `[^N]` with integer N           → expand by alias type
       * `[^anything]` (string-stuffed)  → drop (unresolvable, never
                                            guessed)
       * any other bracket-text          → pass through verbatim
  3. After emitting the expansion, peek look-ahead chars. If the next
     non-whitespace char is trailing punctuation (`.,!?…:;`) — swap
     order so the punctuation lands BEFORE the widget. LLMs habitually
     write `Текст [^1].` which renders ugly on the client; we want
     `Текст. [cite:...|caption]`.

Server-side expansion (alias type → client widget):
  ChunkRef + start_ms/end_ms → [cite:track_X@start-end|caption?]   audio
  ChunkRef without start/end → [card:track_X]                       card
  VerseRef                   → [verse:src/tokens|addr_label]        verse
  MediaRef                   → [media:item_id|caption]              media clip

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
from typing import NamedTuple

from shruti_chat.agent.turn_aliases import (
    ChapterRef,
    ChunkRef,
    CommentaryRef,
    MediaRef,
    TurnAliasMap,
    VerseRef,
)
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


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


# `[^N]` with integer N, optionally `[^N|s=0,2,5]` for commentary
# blockquote sub-selection (sentence indices into the chunk body).
# The `|s=...` suffix is silently ignored when the alias resolves to
# a non-commentary ref (lecture / verse) so a stray suffix on a wrong
# ref type can't break the stream.
_FOOTNOTE_RE = re.compile(r"^\[\^(\d+)(?:\|s=([0-9,]+))?\]$")

# Catch-all `[^anything]` — non-integer string-stuffed hallucination.
_FOOTNOTE_CATCH_RE = re.compile(r"^\[\^[^\]]*\]$")

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
_KEYWORD_BRACKET_RE = re.compile(
    r"^\[(?:cite|card|outline|verse|chapter|media|commentary|action|followup)[:|]"
)
_STRICT_PATTERNS = (
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
# pdf tool minted is a hallucination — we DROP it (see `_expand_marker`)
# so the client never renders the orphan as «Карточка повреждена».
_ACTION_ID_RE = re.compile(r"^\[action:[a-z][a-z0-9_]*\|id=([A-Za-z0-9_-]+)\]$")

# Extracts (source_id, tokens) from a grammar-valid bypass verse/chapter marker.
# A legit verse/chapter card always reaches the client via `[^N]` alias
# expansion; a raw `[verse:src/tokens]` the model TYPED is only legitimate when
# that ref was actually surfaced this turn. One typed for content never
# retrieved is a hallucination (observed: prose «глава 16, стихи 4-18» but the
# marker was `[verse:…/17.16]`) — validate against the alias map, DROP if absent.
_CARD_REF_RE = re.compile(
    r"^\[(?:verse|chapter):([A-Za-z0-9_]+)/([0-9.,-]+)(?:\|[^\]\n]*)?\]$"
)

# Runaway buffer cap — if we don't see `]` after this many chars, it
# wasn't a marker.
_MAX_BUFFER = 200

# Punctuation that should land BEFORE the expanded widget on swap.
_TRAILING_PUNCT = ".,!?…:;"

# Internal sentinel returned from `_format_commentary` when the new
# commentary expansion was MERGED into `_pending` in place (same
# attribution as the run currently in flight). `_on_marker_closed`
# treats this as "already emitted, eat the marker silently". Never
# reaches the output stream.
_MERGE_SENTINEL = "\x02"


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
        emitted_action_ids: set[str] | None = None,
        commentary_as_card: bool = False,
        lazy_cards: bool = False,
    ) -> None:
        self._aliases = aliases
        self._request_id = request_id
        # When True (card-capable client), the auto-render cards (verse / cite
        # / media / chapter) are emitted LAZILY at synth time: expanding the
        # card's marker queues `(family, alias_num, ref)` here, and the
        # synthesizer bridge builds + (cited-only) translates + emits the
        # payload just before the marker's delta — driven by the single
        # `_worker_common.CARD_SPECS` registry. When False (legacy clients),
        # the eager `flush_card_payloads` emits every aliased card up front.
        self._lazy_cards = lazy_cards
        self._pending_card_requests: list[CardRequest] = []
        # When True (client declared the `commentary_card` capability),
        # `_format_commentary` emits a `[commentary:item/seg|s=…|addr]`
        # marker — handled exactly like `[verse:…]` (its structured payload
        # rides ahead via `flush_commentary_payloads`). When False (legacy
        # clients), it keeps inlining a markdown blockquote. Card mode also
        # bypasses the same-source blockquote MERGE — each marker is its own
        # card, and cards stack cleanly without the glued-blockquote problem.
        self._commentary_as_card = commentary_as_card
        # Commentary `action` envelopes queued during marker expansion (card
        # mode), drained by the synthesizer via `take_commentary_actions()`
        # and written to the SSE stream just before the delta carrying the
        # `[commentary:N]` marker. Empty in legacy (blockquote) mode.
        self._pending_commentary_actions: list[dict] = []
        # Action ids that fired as a real `action` SSE event this turn.
        # Shared by reference with `TurnContext.emitted_action_ids`; the
        # worker's `_yield_event` keeps adding to it while the graph runs,
        # and by the time the synthesizer streams through this expander
        # every action for the turn has already been emitted. A grammar-
        # valid `[action:...|id=X]` whose X is NOT in here is a model
        # hallucination → dropped. `None` (tests / non-action turns) means
        # "no validation set" → grammar-valid action markers pass through
        # unchanged, preserving legacy behaviour.
        self._emitted_action_ids = emitted_action_ids

        # Optional 1-based-position → alias remap. The synthesizer numbers
        # its research notes by their POSITION in the final note list
        # (1..N), the same index-space the synthesis planner uses for
        # `supporting_notes` and the outline directive — so the LLM is shown
        # ONE consistent set of `[^N]` numbers. Aliases, by contrast, are
        # minted at retrieval time in fetch order, which does NOT match note
        # position. This map lets the LLM keep emitting position tokens while
        # the expander resolves them back to the real alias. `None` ⇒ the
        # `[^N]` token already IS the alias (legacy / non-synthesis paths).
        # Set via `set_ref_remap` immediately before a synthesis stream;
        # history is folded WITHOUT `[^N]` markers, so no prior-turn token
        # is mis-mapped.
        self._ref_remap: dict[int, int] | None = None

        # Marker-buffer state.
        self._marker_buffer: list[str] = []
        self._in_marker = False

        # Aliases successfully expanded so far — used for within-response
        # dedup in `_format_ref`.
        self._emitted: set[int] = set()

        # Count of `[<keyword>...]` brackets we DROPPED because they
        # looked like one of our marker types but didn't match the
        # strict grammar (visible-garbage protection — the client
        # would render them as raw text in the bubble). Read at
        # end-of-turn by auto-scoring as `malformed_markers_count`.
        self._malformed_count: int = 0

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

        # If `_pending` currently holds a commentary blockquote, these
        # carry the structured state needed to MERGE a follow-up
        # commentary marker with the same `(author, addr_label)` into
        # the same blockquote — appending its sentence picks instead of
        # producing a second visually-glued one. Cleared the moment
        # `_pending` flushes (prose interrupts) or a non-commentary
        # marker arrives.
        #
        # Picks carry both the original sentence index and the sentence
        # text so the renderer can group consecutive indices into one
        # joined run and insert ` … ` between non-consecutive runs.
        # When the LLM emitted `[^N]` without `|s=...` we use synthetic
        # indices 0..N-1 (default first-K behaviour from `_format_commentary`).
        self._pending_comm_picks: list[tuple[int, str]] | None = None
        self._pending_comm_attribution: str | None = None

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
        if expanded == _MERGE_SENTINEL:
            # `_format_commentary` already extended `_pending` in place
            # for a same-source commentary continuation. Eat the marker
            # silently — and discard `_ws_hold` (the whitespace that
            # sat between the two markers belongs to neither and must
            # not leak into the merged blockquote).
            self._ws_hold = ""
            return

        if not expanded:
            # Marker dropped (legacy / hallucinated / unrecovered / dedup).
            # Normalisations:
            #   (a) discard `_ws_hold` — the whitespace that sat
            #       immediately before `[` belongs to the dropped
            #       marker and should not survive as extra spacing
            #   (b) discard `_pending_gap` — the gap was the space
            #       between an earlier pending expansion and this
            #       now-dropped marker, no longer needed
            #   (c) KEEP `_pending` itself. Don't commit it yet —
            #       the next char might be trailing punctuation that
            #       should swap with the pending marker, and an early
            #       commit here would lose that opportunity. Real
            #       case the user hit: `text [^1] [^1].` — dedup drops
            #       the second `[^1]`; if we committed pending=cite_1
            #       on the drop, the `.` would land AFTER the chip
            #       instead of swapping to before. Leaving pending
            #       intact lets the swap fire on the next char.
            self._ws_hold = ""
            self._pending_gap = ""
            return

        # Successful expansion. If we already had a pending one, flush
        # it first (two markers in a row — second is the new pending).
        if self._pending is not None:
            out.append(self._pending_pre_ws + self._pending + self._pending_gap)
            # Whatever the previous pending was, the commentary run
            # tracking is now stale: either prose came in between
            # (handled in _consume_text_char) or a different-source
            # marker is opening a fresh blockquote.
            self._pending_comm_picks = None
            self._pending_comm_attribution = None
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
            self._pending_comm_picks = None
            self._pending_comm_attribution = None
            return ch + " " + expansion

        # Non-punct, non-space → no swap. Commit pre_ws + expansion +
        # gap + ch.
        pre_ws = self._pending_pre_ws
        expansion = self._pending
        gap = self._pending_gap
        self._pending = None
        self._pending_pre_ws = ""
        self._pending_gap = ""
        # Prose continuing → commentary run is over; any follow-up
        # commentary marker is a NEW blockquote, not an extension.
        self._pending_comm_picks = None
        self._pending_comm_attribution = None
        return pre_ws + expansion + gap + ch

    # ── marker expansion ───────────────────────────────────────────

    def _expand_marker(self, marker: str) -> str:
        # `[^N]` or `[^N|s=…]`.
        m = _FOOTNOTE_RE.match(marker)
        if m:
            sentence_indices: list[int] | None = None
            if m.group(2):
                # Parse the comma-separated list; tolerate stray empties
                # from `[^N|s=,0,,2,]`-style sloppy input.
                sentence_indices = []
                for part in m.group(2).split(","):
                    part = part.strip()
                    if not part:
                        continue
                    try:
                        sentence_indices.append(int(part))
                    except ValueError:
                        # Skip non-numeric noise without breaking the
                        # whole marker — partial sub-selection is better
                        # than no quote at all.
                        continue
            return self._format_ref(int(m.group(1)), sentence_indices)

        # Non-integer footnote (e.g. `[^НП 6]`) — unresolvable, drop it.
        if _FOOTNOTE_CATCH_RE.match(marker):
            log.info(
                "chat_marker_footnote_string_stuffed",
                request_id=self._request_id,
                marker=marker[:80],
            )
            return self._format_ref(None, None)

        # `[<word>...]` where `<word>` looks like one of our marker
        # keywords (exact or 3-char typo prefix). Two sub-cases:
        #   * any of the strict per-kind grammars accepts it →
        #     pass through verbatim (bypass-protocol; the bypass audit
        #     elsewhere logs it, the client renders fine);
        #   * else → DROP and count. LLM hallucinations like
        #     `[cite:track_X@notanumber-...]`, typos like
        #     `[citataion:...]`, unclosed `[verse:` etc. Sending them
        #     to the client would surface as visible garbage inside
        #     the bubble. Counted via `_malformed_count` and surfaced
        #     as the `malformed_markers_count` score at end-of-turn.
        if _KEYWORD_BRACKET_RE.match(marker):
            for pattern in _STRICT_PATTERNS:
                if pattern.match(marker):
                    # Action markers carry an `id=` that must correspond to
                    # an `action` SSE event actually emitted this turn.
                    # A grammar-valid marker whose id never fired is a
                    # hallucination (the model wrote a marker even though
                    # no propose_* / pdf tool minted an id) — DROP it so
                    # the client doesn't render an orphan «Карточка
                    # повреждена». This is marker VALIDATION, not lenient
                    # parsing: we stay strict, and additionally require the
                    # id to be real.
                    am = _ACTION_ID_RE.match(marker)
                    if am is not None and self._emitted_action_ids is not None:
                        if am.group(1) not in self._emitted_action_ids:
                            self._malformed_count += 1
                            log.info(
                                "chat_action_marker_orphan_dropped",
                                request_id=self._request_id,
                                action_id=am.group(1),
                                emitted=sorted(self._emitted_action_ids),
                            )
                            return ""
                    # Verse/chapter card markers: same validation — a grammar-
                    # valid card the model TYPED for a verse/chapter never
                    # surfaced this turn is a hallucination. Legit cards arrive
                    # via `[^N]` expansion, so any raw one here must match a
                    # turn alias or it's dropped.
                    cm = _CARD_REF_RE.match(marker)
                    if cm is not None and not self._aliases.has_verse_or_chapter(
                        cm.group(1), cm.group(2)
                    ):
                        self._malformed_count += 1
                        log.info(
                            "chat_card_marker_ungrounded_dropped",
                            request_id=self._request_id,
                            marker=marker[:120],
                        )
                        return ""
                    return marker
            self._malformed_count += 1
            log.info(
                "chat_marker_malformed_dropped",
                request_id=self._request_id,
                marker=marker[:120],
            )
            return ""

        # Anything else (plain bracketed prose like `[см. БГ 2.13]`)
        # passes through verbatim.
        return marker

    @property
    def malformed_count(self) -> int:
        """Number of keyword-prefixed brackets dropped because they
        didn't match the strict marker grammar. Read at end-of-turn
        by `emit_turn_scores`."""
        return self._malformed_count

    def set_ref_remap(self, remap: dict[int, int] | None) -> None:
        """Install a 1-based-position → alias map for the upcoming stream.

        The synthesizer renders its note headers (and the outline planner
        numbers its `supporting_notes`) by note POSITION, not by alias.
        Without a remap those position tokens would resolve to whichever
        alias happens to share the integer — pointing the citation chip at
        the wrong lecture / verse / author. Calling this right before the
        synthesis stream makes `[^position]` resolve to the correct alias.
        Pass `None` to clear (token == alias)."""
        self._ref_remap = remap

    def _format_ref(self, n: int | None, sentence_indices: list[int] | None = None) -> str:
        """Resolve alias N. If N is None or unknown, drop the marker with
        a diagnostic log — never guess.

        Deduplicates within a response: if the alias has already been
        emitted in this stream, drop the second+ occurrence silently.
        The prompt instructs the LLM to use each cite at most once;
        this is the server-side enforcement so any model slip-up
        doesn't produce spammy duplicate chips."""
        ref: ChunkRef | VerseRef | None = None
        if isinstance(n, int) and self._ref_remap is not None:
            # The LLM emitted a note POSITION (synthesizer note-header /
            # outline index-space). Translate to the real alias before any
            # resolve / dedup / caption lookup so every downstream lookup
            # keys on the alias, not the position. A position the map
            # doesn't know falls through unchanged → handled as an
            # alias-miss below (drop, never guess).
            n = self._ref_remap.get(n, n)
        if isinstance(n, int):
            # Dedup: if this exact alias has already been expanded in
            # this response, drop with log.
            if n in self._emitted:
                log.info(
                    "chat_marker_dedup_dropped",
                    request_id=self._request_id,
                    ref=n,
                )
                return ""
            ref = self._aliases.resolve(n)

        if ref is None:
            # Unresolvable marker (no number, or an alias the LLM
            # invented). Drop it — a missing citation is a safe failure;
            # substituting a guessed source risks attaching a confident
            # chip to an unrelated lecture, which for this product is far
            # worse than no chip. The sequential 1..K alias allocation
            # (see TurnAliasMap) already removed the root cause that the
            # old single-candidate recovery was bolted on to handle.
            log.info(
                "chat_marker_alias_miss",
                request_id=self._request_id,
                kind="ref",
                ref=n,
                known_max=len(self._aliases),
                emitted=sorted(self._emitted),
                remaining=sorted(self._aliases.known_keys() - self._emitted),
            )
            return ""

        assert isinstance(n, int)
        self._emitted.add(n)

        if isinstance(ref, CommentaryRef):
            # Card mode (client declared `commentary_card`): emit a numeric
            # marker `[commentary:N]` and queue an `action` payload carrying
            # ONLY the cited sentences + author + reference — exactly the
            # audio-citation shape (text rides in the SSE action, not the
            # marker). Legacy clients keep the inline blockquote.
            if self._commentary_as_card:
                return self._format_commentary_card(n, ref, sentence_indices)
            return self._format_commentary(ref, sentence_indices)

        # Card clients: queue each auto-render card for lazy synth-time emit
        # (build + cited-only translate). The `family` keys the
        # `_worker_common.CARD_SPECS` registry the bridge dispatches on.
        if isinstance(ref, VerseRef):
            self._queue_card("verse", n, ref)
            body = f"{ref.source_id}/{ref.tokens}"
            label = ref.addr_label or ""
            return f"[verse:{body}|{label}]" if label else f"[verse:{body}]"

        if isinstance(ref, MediaRef):
            self._queue_card("media", n, ref)
            # Caption defaults to the server-built label ("speaker · date" /
            # title). The full playable payload (url + type + text) rides
            # ahead of this marker via the `media` SSE event; the marker
            # itself only carries the id the client keys on + a caption.
            caption = ref.label or ""
            return f"[media:{ref.item_id}|{caption}]" if caption else f"[media:{ref.item_id}]"

        if isinstance(ref, ChapterRef):
            self._queue_card("chapter", n, ref)
            body = f"{ref.source_id}/{ref.region_token}"
            label = ref.region_label or ""
            return f"[chapter:{body}|{label}]" if label else f"[chapter:{body}]"

        if isinstance(ref, ChunkRef):
            if ref.start_ms is not None and ref.end_ms is not None:
                self._queue_card("cite", n, ref)
                body = f"{ref.track_id}@{ref.start_ms}-{ref.end_ms}"
                caption = self._aliases.captions.get(n, "")
                return f"[cite:{body}|{caption}]" if caption else f"[cite:{body}]"
            return f"[card:{ref.track_id}]"

        return ""

    def _format_commentary(
        self,
        ref: CommentaryRef,
        sentence_indices: list[int] | None,
    ) -> str:
        """Build a markdown blockquote from VERBATIM sentences of the
        commentary chunk. LLM picks indices; server pulls bytes.

        If `sentence_indices` is None or empty (LLM emitted `[^N]`
        without `|s=...`) → default to the first 2 sentences. This is a
        sensible "the LLM forgot to be specific" fallback that still
        produces a real quote instead of an empty block.

        Out-of-range indices are silently dropped; if NONE of the
        requested indices resolve to a real sentence, return empty
        (marker effectively disappears — preferable to a fake quote).
        """
        # Prefer the per-sentence MT translation when the worker filled it
        # (translate_citations on, no native variant); otherwise the verbatim
        # source sentences. Index-aligned, so `[^N|s=…]` picks still resolve.
        sents = ref.sentences_translated or ref.sentences
        if not sents:
            return ""

        # Build `picks: list[(idx, sentence_text)]`. Preserving the
        # original index per pick lets the renderer detect consecutive
        # vs. non-consecutive runs (joined with space vs. ` … `).
        if not sentence_indices:
            picks: list[tuple[int, str]] = [(i, sents[i]) for i in range(min(2, len(sents)))]
        else:
            picks = []
            for idx in sentence_indices:
                if 0 <= idx < len(sents):
                    picks.append((idx, sents[idx]))
            if not picks:
                log.info(
                    "chat_marker_commentary_no_valid_sentences",
                    request_id=self._request_id,
                    requested=sentence_indices,
                    available=len(sents),
                )
                return ""

        # Language-neutral attribution: `author, addr_label` (or just
        # addr_label). No service word like "комментарий к" — addr_label is
        # already self-describing for every quotable kind ("ШБ 4.1.39",
        # "Letter to …, 1972", "Founding, глава 2.2 «…»"), and a hardcoded
        # Russian word would leak into English answers (the expander has no
        # response-language signal). This same path serves commentary,
        # prose_chapter and letter — see library_to_envelope.
        author = ref.author_name or ""
        attribution = f"{author}, {ref.addr_label}" if author else ref.addr_label

        # Same-source MERGE: if `_pending` is still a commentary
        # blockquote with the SAME attribution (no prose has flushed
        # it yet), extend it in place instead of producing a second
        # adjacent blockquote that would render glued under the first.
        # Caller sees the marker as "already handled".
        if (
            self._pending is not None
            and self._pending_comm_attribution == attribution
            and self._pending_comm_picks is not None
        ):
            self._pending_comm_picks.extend(picks)
            self._pending = self._render_commentary_blockquote(
                self._pending_comm_picks, attribution,
            )
            return _MERGE_SENTINEL

        # Fresh commentary expansion — capture the picks + attribution
        # so a follow-up marker can extend us.
        self._pending_comm_picks = list(picks)
        self._pending_comm_attribution = attribution
        return self._render_commentary_blockquote(picks, attribution)

    def _format_commentary_card(
        self,
        n: int,
        ref: CommentaryRef,
        sentence_indices: list[int] | None,
    ) -> str:
        """Card-mode counterpart of the blockquote path, modelled on the
        audio citation: emit a numeric marker `[commentary:N]` and queue an
        `action` payload carrying ONLY the cited sentences (joined the same
        way the blockquote joins them) plus author + reference. The
        synthesizer drains `take_commentary_actions()` and writes the SSE
        `action` BEFORE the delta that carries this marker, so the client
        has the payload when it renders the card.

        Selection rules mirror `_format_commentary`: no `|s=…` → first 2
        sentences; out-of-range indices dropped; none valid → empty (marker
        disappears, no payload queued)."""
        shown = ref.sentences_translated or ref.sentences
        if not sentence_indices:
            idxs = list(range(min(2, len(shown))))
        else:
            idxs = [i for i in sentence_indices if 0 <= i < len(shown)]
        if not idxs:
            log.info(
                "chat_marker_commentary_no_valid_sentences",
                request_id=self._request_id,
                requested=sentence_indices,
                available=len(shown),
            )
            return ""

        text = self._join_commentary_picks([(i, shown[i]) for i in idxs])
        if not text:
            return ""
        payload: dict[str, object] = {
            "ref": n,
            "author_name": ref.author_name or "",
            "addr_label": ref.addr_label or "",
            "kind": ref.kind,
            "text": text,
        }
        # When machine-translated, ship the original (English) of the SAME
        # picked sentences so the card's original/translation toggle works.
        if ref.mt and ref.sentences_translated is not None:
            originals = [(i, ref.sentences[i]) for i in idxs if i < len(ref.sentences)]
            text_original = self._join_commentary_picks(originals)
            if text_original and text_original != text:
                payload["text_original"] = text_original
                payload["mt"] = True
        self._pending_commentary_actions.append(
            {"type": "action", "data": {"kind": "commentary", "id": f"commentary_{n}", "payload": payload}}
        )
        return f"[commentary:{n}]"

    def take_commentary_actions(self) -> list[dict]:
        """Return + clear the commentary `action` envelopes queued since the
        last call. The synthesizer drains this after each `feed()` / `flush()`
        and writes them to the SSE stream BEFORE the delta carrying their
        `[commentary:N]` markers (payload-before-marker invariant)."""
        if not self._pending_commentary_actions:
            return []
        out = self._pending_commentary_actions
        self._pending_commentary_actions = []
        return out

    def _queue_card(self, family: str, ref_num: int, ref: CardRef) -> None:
        """Queue one auto-render card for lazy synth-time emit (card clients
        only — `_lazy_cards`). No-op for legacy clients, whose payloads come
        from the eager `flush_card_payloads`."""
        if self._lazy_cards:
            self._pending_card_requests.append(CardRequest(family, ref_num, ref))

    def take_card_requests(self) -> list[CardRequest]:
        """Return + clear the cards queued since the last call. The synthesizer
        bridge builds + (cited-only) translates + emits each one's payload
        BEFORE the delta carrying its marker — only for the cards actually
        cited, so the uncited candidate pool costs no fetch / translation."""
        if not self._pending_card_requests:
            return []
        out = self._pending_card_requests
        self._pending_card_requests = []
        return out

    def _join_commentary_picks(self, picks: list[tuple[int, str]]) -> str:
        """Join selected sentences into one body string. Picks are sorted by
        index, then grouped into consecutive runs: within a run sentences are
        adjacent in the source purport so they join with a single space; a
        gap between runs becomes ` … ` (Unicode ellipsis) to signal the skip.
        Shared by the inline blockquote and the card payload so both render
        the same quote text. Returns "" when nothing survives stripping."""
        cleaned: list[tuple[int, str]] = [
            (idx, sent.strip())
            for idx, sent in sorted(picks, key=lambda p: p[0])
            if sent and sent.strip()
        ]
        if not cleaned:
            return ""
        runs: list[list[str]] = []
        prev_idx: int | None = None
        for idx, sent in cleaned:
            if prev_idx is None or idx != prev_idx + 1:
                runs.append([sent])
            else:
                runs[-1].append(sent)
            prev_idx = idx
        return " … ".join(" ".join(r) for r in runs)

    def _render_commentary_blockquote(
        self,
        picks: list[tuple[int, str]],
        attribution: str,
    ) -> str:
        """Pure renderer — takes the merged (sentence_index, sentence_text)
        picks and produces the full blockquote string. Used both for fresh
        expansions and for re-rendering `_pending` when a same-source merge
        appends new picks.

        Sentence-join policy: picks are sorted by index (LLM may emit
        out-of-order), then grouped into consecutive runs. Within a run,
        sentences are joined with a single space — they're adjacent in
        the source purport, so they read naturally as one continuous
        thought. Between non-consecutive runs we insert ` … ` (Unicode
        ellipsis surrounded by spaces) to signal a skip in the source.

        Internal newlines within a single sentence (multi-line shloka
        quotations like "*мāṁ ча йо ’вйабхичāреṇа\\nбхакти-йогена севате*")
        are preserved verbatim and get their own `> ` prefix per line —
        CommonMark requires it on every blockquote line, and the verse
        structure matters visually.

        Leading + trailing newline frame the block:
        - Leading `\\n` so `>` lands at line-start even if the LLM
          forgot to put the marker on its own line.
        - Trailing `\\n` so a DIFFERENT-source commentary marker right
          after this one gets a blank-line separator (one trailing +
          one leading on the next = `\\n\\n`, which markdown reads as
          end-of-blockquote, start-of-new-blockquote).
        """
        body_text = self._join_commentary_picks(picks)
        if not body_text:
            return ""

        # Now wrap the joined body in blockquote prefixes. Internal
        # newlines (sanskrit shlokas) get `> ` per line; empty internal
        # lines become bare `>` so the blockquote stays continuous
        # across stanza breaks.
        rendered: list[str] = []
        for line in body_text.split("\n"):
            stripped = line.strip()
            rendered.append(f"> {stripped}" if stripped else ">")
        body = "\n".join(rendered)
        # Attribution line is wrapped in `*…*` (the WHOLE line, em-dash
        # included) so the mobile client's `parseQuoteBlock` recognises it
        # as the styled attribution and peels it off the blockquote body.
        # That peel fires ONLY when the last quote line is wholly italic
        # (`^\*…\*$`); a bare `> — author` falls through and renders as
        # plain body text. Keep both sides in lockstep — see
        # composables/chatMarkers/parse.ts.
        return f"\n{body}\n>\n> *— {attribution}*\n"
