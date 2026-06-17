"""Human-readable marker expansion for the Langfuse trace output.

The assistant answer that ships to the client carries opaque expanded
markers — `[cite:track_X@552480-607280]`, `[commentary:6]`,
`[verse:BG/2.13|БГ 2.13]`, etc. They render as rich chips in the app,
but in a Langfuse trace they are dead ends: you can't tell which lecture
was cited, what was said in that window, or which purport hides behind
`[commentary:6]`. So a reviewer can't judge whether a citation is
relevant or correct.

`annotate_markers` rewrites that text for the TRACE ONLY (never the
client stream): each marker is replaced by a fenced code block holding
the marker itself plus what it resolves to — pulled from the same
per-turn `TurnAliasMap` the marker expander used. The ``` fence makes
Langfuse render it as a distinct monospace box (with blank lines around
it), so a reviewer sees at a glance that it's diagnostic meta, not part
of the answer prose:

    …falldown.

    ```
    [cite:track_eV6bWmyLYcPD@552480-607280]
    ↳ track_eV6bWmyLYcPD · 9:12–10:07

    "…the living entity, being marginal, can come under the influence…"
    ```

What's shown mirrors what the USER saw: commentary uses the picked
sentences the card rendered (translation included), so a translated
purport shows its translation. Audio fragments show the transcript
snippet in its original language (lectures aren't translated per-fragment
in the UI).

Pure + synchronous + dependency-free: it reads only the alias map (no
catalog / DB calls), so it never adds latency to turn completion.
"""

from __future__ import annotations

import re
import textwrap

from shruti_chat.agent.markers import (
    CARD_RE,
    CITE_RE,
    MEDIA_RE,
    OUTLINE_RE,
    VERSE_RE,
)
from shruti_chat.agent.turn_aliases import (
    CommentaryRef,
    TurnAliasMap,
)


# `[commentary:N]` (card mode) and `[chapter:src/region|label]` are
# expanded markers too, but `markers.py` (the bypass/score SSOT) doesn't
# carry them. Defined locally — they are only consumed here.
COMMENTARY_RE = re.compile(r"\[commentary:(\d+)\]")
CHAPTER_RE = re.compile(r"\[chapter:([A-Za-z0-9_]+)/([0-9.,-]+)(?:\|([^\]\n]*))?\]")

# Snippets can be long; keep the trace readable.
_MAX_SNIPPET = 600
# A ``` code fence renders as `pre` in Langfuse — long lines do NOT soft-wrap,
# they scroll off the right edge. So hard-wrap the cited text to a fixed width
# before it goes in the box. Marker / `↳` lines are never wrapped (a marker
# token must stay intact).
_WRAP = 88


def _wrap(line: str) -> str:
    return textwrap.fill(
        line, width=_WRAP, break_long_words=False, break_on_hyphens=False,
    )


def _fmt_ms(ms: int) -> str:
    """`552480` → `9:12`, `3723000` → `1:02:03`."""
    total = ms // 1000
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _truncate(text: str) -> str:
    text = text.strip()
    if len(text) > _MAX_SNIPPET:
        return text[:_MAX_SNIPPET].rstrip() + " […]"
    return text


def _block(marker: str, lines: list[str]) -> str:
    """Replace the marker with a fenced code block — surrounded by blank
    lines — laid out as: the marker, the `↳` locator line right under it,
    then a blank line, then the cited content (snippet / sentences /
    chapter titles).

    The fence makes Langfuse render the whole thing as a distinct monospace
    box (diagnostic meta, not answer text); the marker + locator read as
    the reference header, and the blank line sets the quoted content apart
    from it. Markers we can't resolve come back unchanged."""
    lines = [line for line in lines if line]
    if not lines:
        return marker
    head, rest = lines[0], lines[1:]
    inner = f"{marker}\n{head}"
    if rest:
        inner += "\n\n" + "\n".join(_wrap(line) for line in rest)
    return f"\n\n```\n{inner}\n```\n\n"


def annotate_markers(text: str, aliases: TurnAliasMap) -> str:
    """Return `text` with a human-readable expansion inlined under each
    expanded marker. For the Langfuse trace output only — do not send to
    the client. Unknown / unresolvable markers are left untouched."""
    if not text:
        return text

    # Reverse map for `[cite:...]`: the expanded marker dropped the alias
    # integer, so rebuild `track@start-end → (alias, snippet)` from the
    # minted chunk refs. `chunk_texts` is keyed by alias int and may be
    # empty for fragments aliased outside the research pipeline — then we
    # show just the timestamp.
    cite_text: dict[str, str] = {}
    for n, ref in aliases.cite_refs():
        key = f"{ref.track_id}@{ref.start_ms}-{ref.end_ms}"
        cite_text[key] = aliases.chunk_texts.get(n, "")

    def _cite(m: re.Match[str]) -> str:
        track_id, start, end = m.group(1), int(m.group(2)), int(m.group(3))
        window = f"{_fmt_ms(start)}–{_fmt_ms(end)}"
        snippet = cite_text.get(f"{track_id}@{start}-{end}", "")
        lines = [f"↳ {track_id} · {window}"]
        if snippet:
            lines.append(f'"{_truncate(snippet)}"')
        return _block(m.group(0), lines)

    def _commentary(m: re.Match[str]) -> str:
        n = int(m.group(1))
        ref = aliases.resolve(n)
        if not isinstance(ref, CommentaryRef):
            return m.group(0)
        attribution = (
            f"{ref.author_name}, {ref.addr_label}"
            if ref.author_name
            else ref.addr_label
        )
        # Mirror exactly what the user saw: the picked sentences the card
        # rendered (translation included), stashed at expansion time. Fall
        # back to the full source body (translated when present) only if the
        # picks weren't captured — e.g. a non-card path or a replayed marker.
        shown = aliases.commentary_shown.get(n)
        if not shown:
            sents = ref.sentences_translated or ref.sentences
            shown = " ".join(sents) if sents else ""
        lines = [f"↳ {attribution}"]
        if shown:
            lines.append(f'"{_truncate(shown)}"')
        return _block(m.group(0), lines)

    def _chapter(m: re.Match[str]) -> str:
        source_id, region_token = m.group(1), m.group(2)
        label = m.group(3) or ""
        # Pull the chapter titles from the matching ChapterRef.
        titles: list[str] = []
        for _, cref in aliases.chapter_refs():
            if cref.source_id == source_id and cref.region_token == region_token:
                titles = [f"{tok} {title}".strip() for tok, title in cref.chapters]
                break
        lines = [f"↳ {label}" if label else f"↳ {source_id}/{region_token}"]
        lines.extend(titles)
        return _block(m.group(0), lines)

    def _media(m: re.Match[str]) -> str:
        caption = m.group(2) or ""
        lines = [f"↳ {caption}"] if caption else [f"↳ {m.group(1)}"]
        return _block(m.group(0), lines)

    def _track_only(m: re.Match[str]) -> str:
        return _block(m.group(0), [f"↳ {m.group(1)} (whole track)"])

    out = text
    out = CITE_RE.sub(_cite, out)
    out = COMMENTARY_RE.sub(_commentary, out)
    out = CHAPTER_RE.sub(_chapter, out)
    out = VERSE_RE.sub(
        lambda m: _block(
            m.group(0),
            [f"↳ {m.group(3) or (m.group(1) + '/' + m.group(2))}"],
        ),
        out,
    )
    out = MEDIA_RE.sub(_media, out)
    out = CARD_RE.sub(_track_only, out)
    out = OUTLINE_RE.sub(_track_only, out)
    return out
