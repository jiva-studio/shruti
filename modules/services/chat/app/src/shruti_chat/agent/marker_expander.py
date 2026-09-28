"""Stream-side marker expander for the footnote-refs protocol.

The model writes `[^N]` in its prose where `N` is a small sequential
integer alias minted by `TurnAliasMap`. This filter sits between the
LLM stream and the client SSE stream:

  1. Buffer characters between `[` and `]` to detect markers.
  2. When a marker closes, parse it (`marker_tokens`):
       * `[^N]` with integer N           → expand by alias type
                                            (`marker_expansion`,
                                            `marker_commentary`)
       * `[^anything]` (string-stuffed)  → drop (unresolvable, never
                                            guessed)
       * any other bracket-text          → pass through verbatim
  3. After emitting the expansion, peek look-ahead chars. If the next
     non-whitespace char is trailing punctuation (`.,!?…:;`) — swap
     order so the punctuation lands BEFORE the widget. LLMs habitually
     write `Текст [^1].` which renders ugly on the client; we want
     `Текст. [cite:...|caption]`.

Captions for audio fragments come from `TurnAliasMap.captions`,
populated by a background Flash-Lite call in `research.pipeline`. If
not ready when expanding → emit `[cite:track_X@start-end]` without
caption; the chip degrades gracefully. Card and commentary payloads
queued during expansion wait in the `MarkerOutbox` until the synthesizer
writes them ahead of their markers.

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

from typing import Any

from shruti_chat.agent.marker_commentary import (
    attribution_of,
    commentary_card_action,
    commentary_selection,
    join_commentary_picks,
    render_commentary_blockquote,
    selected_indices,
    shown_sentences,
)
from shruti_chat.agent.marker_expansion import alias_marker, check_bypass_marker
from shruti_chat.agent.marker_outbox import CardRequest, MarkerOutbox
from shruti_chat.agent.marker_tokens import (
    FOOTNOTE_CATCH_RE,
    KEYWORD_BRACKET_RE,
    MAX_BUFFER,
    TRAILING_PUNCT,
    parse_footnote,
)
from shruti_chat.agent.markers import SENTENCE_MARKER_LEAK_RE
from shruti_chat.agent.turn_aliases import CommentaryRef, TurnAliasMap
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


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
        emitted_outline_ids: set[str] | None = None,
        commentary_as_card: bool = False,
        lazy_cards: bool = False,
    ) -> None:
        self._aliases = aliases
        self._request_id = request_id
        # When `lazy_cards` (card-capable client), the auto-render cards
        # (verse / cite / media / chapter) are emitted LAZILY at synth time:
        # expanding the card's marker queues `(family, alias_num, ref)` in the
        # outbox, and the synthesizer bridge builds + (cited-only) translates +
        # emits the payload just before the marker's delta — driven by the
        # single `_worker_common.CARD_SPECS` registry. Otherwise (legacy
        # clients) the eager `flush_card_payloads` emits every aliased card up
        # front. Commentary `action` envelopes (card mode) wait there too.
        self._outbox = MarkerOutbox(lazy_cards=lazy_cards)
        # When True (client declared the `commentary_card` capability),
        # `_format_commentary_card` emits a `[commentary:N]` marker whose
        # structured payload rides ahead as an `action`. When False (legacy
        # clients), a markdown blockquote is inlined. Card mode also
        # bypasses the same-source blockquote MERGE — each marker is its own
        # card, and cards stack cleanly without the glued-blockquote problem.
        self._commentary_as_card = commentary_as_card
        # Action ids that fired as a real `action` SSE event this turn.
        # Shared by reference with `TurnContext.emitted_action_ids`; the
        # worker's `_yield_event` keeps adding to it while the graph runs,
        # and by the time the synthesizer streams through this expander
        # every action for the turn has already been emitted. A grammar-
        # valid `[action:...|id=X]` whose X is NOT in here is a model
        # hallucination → dropped. `None` (tests / non-action turns) means
        # "no validation set" → grammar-valid action markers pass through
        # unchanged.
        self._emitted_action_ids = emitted_action_ids

        # Track ids for which `track_outline_get` actually ran this turn
        # (each emits an `outline` action carrying the card's items). A
        # grammar-valid `[outline:track_X]` whose track is NOT in here is a
        # model hallucination → dropped, so the client never mounts an empty
        # outline card. `None` (tests / non-outline turns) means "no
        # validation set" → grammar-valid outline markers pass through
        # unchanged, mirroring `_emitted_action_ids`.
        self._emitted_outline_ids = emitted_outline_ids

        # Optional 1-based-position → alias remap. The synthesizer numbers
        # its research notes by their POSITION in the final note list
        # (1..N), the same index-space the synthesis planner uses for
        # `supporting_notes` and the outline directive — so the LLM is shown
        # ONE consistent set of `[^N]` numbers. Aliases, by contrast, are
        # minted at retrieval time in fetch order, which does NOT match note
        # position. This map lets the LLM keep emitting position tokens while
        # the expander resolves them back to the real alias. `None` ⇒ the
        # `[^N]` token already IS the alias (non-synthesis paths).
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

        # Per commentary alias, the union of sentence indices already shown
        # in this response. Lets a repeat `[^N|s=…]` selecting a DIFFERENT
        # range survive the dedup gate (a second, disjoint quote of the same
        # purport) while an identical re-cite is still dropped.
        self._emitted_comm_sel: dict[int, frozenset[int]] = {}

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
                elif len(self._marker_buffer) > MAX_BUFFER:
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
            #       commit here would lose that opportunity. E.g.
            #       `text [^1] [^1].` — dedup drops
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

        if ch in TRAILING_PUNCT:
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
        footnote = parse_footnote(marker)
        if footnote is not None:
            n, sentence_indices = footnote
            return self._format_ref(n, sentence_indices)

        # Non-integer footnote (e.g. `[^НП 6]`) — unresolvable, drop it.
        if FOOTNOTE_CATCH_RE.match(marker):
            log.info(
                "chat_marker_footnote_string_stuffed",
                request_id=self._request_id,
                marker=marker[:80],
            )
            return self._format_ref(None, None)

        # `[<keyword>...]` the model typed out itself (bypass protocol). It
        # passes verbatim only when grammar-valid AND grounded this turn;
        # anything else is dropped and counted via `_malformed_count`, surfaced
        # as the `malformed_markers_count` score at end-of-turn.
        if KEYWORD_BRACKET_RE.match(marker):
            verdict = check_bypass_marker(
                marker,
                aliases=self._aliases,
                emitted_action_ids=self._emitted_action_ids,
                emitted_outline_ids=self._emitted_outline_ids,
            )
            if verdict.keep:
                return marker
            self._malformed_count += 1
            log.info(verdict.event, request_id=self._request_id, **(verdict.fields or {}))
            return ""

        # Bare `[s=N,…]` sentence-index token. The `|s=…` payload is only
        # legal as a SUFFIX inside `[^N|s=…]`; a standalone `[s=0,2]` is
        # producer-side garbage (the synth note renderer's `[s=N]` markers
        # leaking past the model). It matches none of the keyword grammars, so
        # it would otherwise pass through verbatim and surface as garbage in
        # the bubble. Drop it AND count it as malformed.
        if SENTENCE_MARKER_LEAK_RE.fullmatch(marker):
            self._malformed_count += 1
            log.info(
                "chat_marker_sentence_token_leak_dropped",
                request_id=self._request_id,
                marker=marker[:80],
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
        ref: Any = None
        if isinstance(n, int) and self._ref_remap:
            # The LLM emitted a note POSITION (synthesizer note-header /
            # outline index-space). Translate to the real alias before any
            # resolve / dedup / caption lookup so every downstream lookup
            # keys on the alias, not the position. A non-empty remap is the
            # authoritative position→alias map for this synthesis stream, so a
            # position it does NOT contain is a non-citable note (e.g. a
            # synthesizer note with no backing chunk): drop it as an alias-miss
            # rather than resolving the raw position number as a literal alias
            # — the position integer-space and the alias integer-space differ,
            # so a fall-through could attach a chip to an unrelated source.
            # (An empty remap means "no positional notes this stream" and is
            # treated above as no remap at all — `[^N]` is then the alias.)
            remapped = self._ref_remap.get(n)
            if remapped is None:
                log.info(
                    "chat_marker_position_unmapped",
                    request_id=self._request_id,
                    position=n,
                )
                return ""
            n = remapped
        if isinstance(n, int):
            ref = self._aliases.resolve(n)
            # Dedup: if this exact alias has already been expanded in
            # this response, drop with log.
            if n in self._emitted:
                # Commentary special-case: a repeat alias that selects a
                # DIFFERENT sentence range of the same purport is NOT a
                # duplicate chip — it's a second, disjoint quote the answer
                # legitimately needs (e.g. `[^5|s=0]` opening the point, then
                # `[^5|s=7]` for a later sentence). Plain dedup would silently
                # drop the second quote. Let it through to `_format_commentary`
                # so the new sentences render. Conservative: only when the new
                # selection differs from what this alias already showed; an
                # identical re-cite is still dropped as a true duplicate.
                if isinstance(ref, CommentaryRef):
                    new_sel = commentary_selection(ref, sentence_indices)
                    prev_sel = self._emitted_comm_sel.get(n)
                    if new_sel and new_sel != prev_sel:
                        self._emitted_comm_sel[n] = (
                            new_sel if prev_sel is None else prev_sel | new_sel
                        )
                        if self._commentary_as_card:
                            return self._format_commentary_card(n, ref, sentence_indices)
                        return self._format_commentary(ref, sentence_indices)
                log.info(
                    "chat_marker_dedup_dropped",
                    request_id=self._request_id,
                    ref=n,
                )
                return ""

        if ref is None:
            # Unresolvable marker (no number, or an alias the LLM
            # invented). Drop it — a missing citation is a safe failure;
            # substituting a guessed source risks attaching a confident
            # chip to an unrelated lecture, which for this product is far
            # worse than no chip.
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
            # Record which sentences this first cite of the alias showed, so a
            # later repeat with a DIFFERENT selection can pass the dedup gate
            # above (a disjoint quote of the same purport).
            sel = commentary_selection(ref, sentence_indices)
            if sel:
                self._emitted_comm_sel[n] = sel
            # Card mode (client declared `commentary_card`): emit a numeric
            # marker `[commentary:N]` and queue an `action` payload carrying
            # ONLY the cited sentences + author + reference — exactly the
            # audio-citation shape (text rides in the SSE action, not the
            # marker). Legacy clients keep the inline blockquote.
            if self._commentary_as_card:
                return self._format_commentary_card(n, ref, sentence_indices)
            return self._format_commentary(ref, sentence_indices)

        # Card clients: queue each auto-render card for lazy synth-time emit
        # (build + cited-only translate).
        family, marker = alias_marker(ref, n, self._aliases.captions)
        if family is not None:
            self._outbox.queue_card(family, n, ref)
        return marker

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
        sents = shown_sentences(ref)
        if not sents:
            return ""

        # Preserving the original index per pick lets the renderer detect
        # consecutive vs. non-consecutive runs (joined with space vs. ` … `).
        picks = [(i, sents[i]) for i in selected_indices(ref, sentence_indices)]
        if not picks:
            log.info(
                "chat_marker_commentary_no_valid_sentences",
                request_id=self._request_id,
                requested=sentence_indices,
                available=len(sents),
            )
            return ""

        attribution = attribution_of(ref)

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
            self._pending = render_commentary_blockquote(
                self._pending_comm_picks, attribution,
            )
            return _MERGE_SENTINEL

        # Fresh commentary expansion — capture the picks + attribution
        # so a follow-up marker can extend us.
        self._pending_comm_picks = list(picks)
        self._pending_comm_attribution = attribution
        return render_commentary_blockquote(picks, attribution)

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
        shown = shown_sentences(ref)
        idxs = selected_indices(ref, sentence_indices)
        if not idxs:
            log.info(
                "chat_marker_commentary_no_valid_sentences",
                request_id=self._request_id,
                requested=sentence_indices,
                available=len(shown),
            )
            return ""

        text = join_commentary_picks([(i, shown[i]) for i in idxs])
        if not text:
            return ""
        # Mirror the rendered quote for the Langfuse trace annotation — the
        # picked sentences only, exactly as the card shows them. Trace-only;
        # the client gets `text` via the `action` payload.
        self._aliases.commentary_shown[n] = text
        self._outbox.queue_commentary_action(commentary_card_action(n, ref, idxs, text))
        return f"[commentary:{n}]"

    def take_commentary_actions(self) -> list[dict]:
        """Return + clear the commentary `action` envelopes queued since the
        last call. The synthesizer drains this after each `feed()` / `flush()`
        and writes them to the SSE stream BEFORE the delta carrying their
        `[commentary:N]` markers (payload-before-marker invariant)."""
        return self._outbox.take_commentary_actions()

    def take_card_requests(self) -> list[CardRequest]:
        """Return + clear the cards queued since the last call. The synthesizer
        bridge builds + (cited-only) translates + emits each one's payload
        BEFORE the delta carrying its marker — only for the cards actually
        cited, so the uncited candidate pool costs no fetch / translation."""
        return self._outbox.take_card_requests()
