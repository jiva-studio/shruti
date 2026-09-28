"""Commentary quotes: which sentences a `[^N|s=…]` marker shows, and how.

The model picks sentence indices; the server pulls the bytes. A quote is
either an inline markdown blockquote (clients without that capability) or an `action` payload
behind a `[commentary:N]` marker (clients with the `commentary_card`
capability). Both render the same joined text.
"""

from __future__ import annotations

from shruti_chat.agent.turn_aliases import CommentaryRef

# Sentences shown when the marker names none (`[^N]` without `|s=…`).
DEFAULT_SENTENCES = 2


def shown_sentences(ref: CommentaryRef) -> list[str]:
    """The per-sentence MT translation when the worker filled it
    (translate_citations on, no native variant); otherwise the verbatim
    source sentences. Index-aligned, so `[^N|s=…]` picks resolve either way."""
    return ref.sentences_translated or ref.sentences


def selected_indices(ref: CommentaryRef, sentence_indices: list[int] | None) -> list[int]:
    """The in-range indices a marker selects, in the order written: the first
    `DEFAULT_SENTENCES` when it selects none."""
    shown = shown_sentences(ref)
    if not sentence_indices:
        return list(range(min(DEFAULT_SENTENCES, len(shown))))
    return [i for i in sentence_indices if 0 <= i < len(shown)]


def commentary_selection(
    ref: CommentaryRef, sentence_indices: list[int] | None,
) -> frozenset[int]:
    """The set of sentence indices a commentary marker would render. Used by
    the dedup gate to tell a repeat alias with a NEW selection (a disjoint
    quote) apart from a true duplicate. Empty when nothing valid resolves."""
    if not shown_sentences(ref):
        return frozenset()
    return frozenset(selected_indices(ref, sentence_indices))


def attribution_of(ref: CommentaryRef) -> str:
    """Language-neutral attribution: `author, addr_label` (or just addr_label).

    No service word like "комментарий к" — addr_label is already
    self-describing for every quotable kind ("ШБ 4.1.39", "Letter to …, 1972",
    "Founding, глава 2.2 «…»"), and a hardcoded Russian word would leak into
    English answers (the expander has no response-language signal). This same
    path serves commentary, prose_chapter and letter — see library_to_envelope.
    """
    author = ref.author_name or ""
    return f"{author}, {ref.addr_label}" if author else ref.addr_label


def join_commentary_picks(picks: list[tuple[int, str]]) -> str:
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


def render_commentary_blockquote(picks: list[tuple[int, str]], attribution: str) -> str:
    """The full blockquote for merged `(sentence_index, sentence_text)` picks.
    Used both for fresh expansions and for re-rendering a pending blockquote
    when a same-source merge appends new picks.

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
    body_text = join_commentary_picks(picks)
    if not body_text:
        return ""

    # Internal newlines (sanskrit shlokas) get `> ` per line; empty internal
    # lines become bare `>` so the blockquote stays continuous across stanza
    # breaks.
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


def commentary_card_action(
    n: int, ref: CommentaryRef, idxs: list[int], text: str,
) -> dict:
    """The `action` envelope behind a `[commentary:N]` marker: ONLY the cited
    sentences plus author and reference — the audio-citation shape. When the
    quote was machine-translated, the original of the SAME sentences rides
    along so the card's original/translation toggle works."""
    payload: dict[str, object] = {
        "ref": n,
        "author_name": ref.author_name or "",
        "addr_label": ref.addr_label or "",
        "kind": ref.kind,
        "text": text,
    }
    if ref.mt and ref.sentences_translated is not None:
        originals = [(i, ref.sentences[i]) for i in idxs if i < len(ref.sentences)]
        text_original = join_commentary_picks(originals)
        if text_original and text_original != text:
            payload["text_original"] = text_original
            payload["mt"] = True
    return {
        "type": "action",
        "data": {"kind": "commentary", "id": f"commentary_{n}", "payload": payload},
    }
