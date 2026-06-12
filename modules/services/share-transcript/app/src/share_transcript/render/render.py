"""Render a printable transcript PDF using reportlab Platypus.

Input shape:

- `track`: domain `TrackMeta` — supplies title, author, date, location, source
  references.
- `transcript`: parsed transcript JSON (`{blocks: [...]}`) as fetched from
  S3 by `TranscriptStorage`. Blocks are `paragraph` / `sentence` /
  `verse:text` / `verse:translation`.
- `outline`: optional outline payload (`{items: [{start_ms, title}]}`)
  as fetched from `OutlineCache`. If present, a "Contents" section is
  emitted on the cover.

Output: PDF bytes. No file I/O — the caller hands the bytes to
`PdfStorage.put` for upload.

Layout decisions:

- A4 page, 18mm margins. Page number + track id in the bottom-right.
- Cover: serif title, sub-title (author), metadata row, optional outline.
- Body: paragraphs grouped by the transcript's `paragraph` markers (or
  the implicit pause at a verse boundary). Each paragraph is preceded
  by a small monospace timecode, then sentence text joined with a single
  space. Verse text is indented and rendered with line breaks
  preserved; the verse's translation, when present, is rendered in
  italic immediately below the verse.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Any, Iterable

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
)

from share_transcript.meta import TrackMeta
from share_transcript.render.fonts import (
    BODY_FONT,
    HEAD_FONT,
    HEAD_FONT_BOLD,
    MONO_FONT,
    register_fonts,
)


# ---------------------------------------------------------------------------
# Localised labels — kept inline (5 strings each) instead of hooking into
# the chat service's i18n stack, which is LLM-prompt-only.
# ---------------------------------------------------------------------------

_LABELS = {
    "ru": {
        "contents": "Содержание",
        "transcript": "Транскрипт",
        "by": "Лектор",
        "date": "Дата",
        "location": "Место",
        "source": "Источник",
        "footer_brand": "Слушай Садху",
    },
    "en": {
        "contents": "Contents",
        "transcript": "Transcript",
        "by": "Speaker",
        "date": "Date",
        "location": "Location",
        "source": "Source",
        "footer_brand": "Shruti",
    },
}


def _labels(lang: str) -> dict[str, str]:
    return _LABELS.get(lang, _LABELS["en"])


# ---------------------------------------------------------------------------
# Style sheet — built once per render so the registered fonts are resolved
# in the same process.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Styles:
    title: ParagraphStyle
    subtitle: ParagraphStyle
    metadata: ParagraphStyle
    section: ParagraphStyle
    section_body: ParagraphStyle
    outline_item: ParagraphStyle
    body: ParagraphStyle
    timecode: ParagraphStyle
    verse: ParagraphStyle
    verse_translation: ParagraphStyle


def _build_styles() -> _Styles:
    return _Styles(
        title=ParagraphStyle(
            "title",
            fontName=HEAD_FONT_BOLD,
            fontSize=22,
            leading=28,
            alignment=TA_LEFT,
            textColor=colors.HexColor("#111111"),
            spaceAfter=4 * mm,
        ),
        subtitle=ParagraphStyle(
            "subtitle",
            fontName=HEAD_FONT,
            fontSize=13,
            leading=17,
            textColor=colors.HexColor("#333333"),
            spaceAfter=8 * mm,
        ),
        metadata=ParagraphStyle(
            "metadata",
            fontName=BODY_FONT,
            fontSize=10,
            leading=14,
            textColor=colors.HexColor("#555555"),
            spaceAfter=2 * mm,
        ),
        section=ParagraphStyle(
            "section",
            fontName=HEAD_FONT_BOLD,
            fontSize=14,
            leading=18,
            textColor=colors.HexColor("#111111"),
            spaceBefore=6 * mm,
            spaceAfter=3 * mm,
        ),
        section_body=ParagraphStyle(
            "section_body",
            fontName=HEAD_FONT_BOLD,
            fontSize=12,
            leading=16,
            textColor=colors.HexColor("#111111"),
            spaceBefore=8 * mm,
            spaceAfter=2 * mm,
            keepWithNext=1,
        ),
        outline_item=ParagraphStyle(
            "outline_item",
            fontName=BODY_FONT,
            fontSize=10.5,
            leading=15,
            leftIndent=4 * mm,
            spaceAfter=1.5 * mm,
            textColor=colors.HexColor("#222222"),
        ),
        body=ParagraphStyle(
            "body",
            fontName=BODY_FONT,
            fontSize=10.5,
            leading=16,
            alignment=TA_LEFT,
            textColor=colors.HexColor("#111111"),
            spaceAfter=4 * mm,
        ),
        timecode=ParagraphStyle(
            "timecode",
            fontName=MONO_FONT,
            fontSize=8.5,
            leading=12,
            textColor=colors.HexColor("#888888"),
            spaceAfter=0,
        ),
        verse=ParagraphStyle(
            "verse",
            fontName=BODY_FONT,
            fontSize=10.5,
            leading=15,
            leftIndent=8 * mm,
            textColor=colors.HexColor("#222222"),
            spaceBefore=2 * mm,
            spaceAfter=2 * mm,
        ),
        verse_translation=ParagraphStyle(
            "verse_translation",
            fontName=f"{BODY_FONT}-Oblique",
            fontSize=10,
            leading=14,
            leftIndent=8 * mm,
            textColor=colors.HexColor("#555555"),
            spaceAfter=4 * mm,
        ),
    )


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------


def _fmt_ts(ms: int) -> str:
    if ms < 0:
        ms = 0
    s = ms // 1000
    h = s // 3600
    m = (s % 3600) // 60
    sec = s % 60
    return f"{h:d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


# ---------------------------------------------------------------------------
# Cover
# ---------------------------------------------------------------------------


def _track_subtitle(track: TrackMeta) -> str:
    """Author plus date – e.g. 'A. C. Bhaktivedanta Swami Prabhupada · 1972'."""
    parts: list[str] = []
    if track.author_name:
        parts.append(track.author_name)
    elif track.author_id:
        parts.append(track.author_id)
    if track.date:
        parts.append(track.date)
    return " · ".join(parts)


def _metadata_lines(track: TrackMeta, lang: str) -> list[str]:
    L = _labels(lang)
    out: list[str] = []
    if track.location_name or track.location_id:
        out.append(f"<b>{L['location']}:</b> {_escape(track.location_name or track.location_id)}")
    if track.references:
        names = []
        for ref in track.references:
            label = ref.short_name or ref.full_name or ref.source_id
            tokens = f" {ref.tokens}" if ref.tokens else ""
            names.append(f"{label}{tokens}")
        out.append(f"<b>{L['source']}:</b> {_escape(', '.join(names))}")
    if track.tag_names:
        out.append("<b>#</b> " + _escape(", ".join(track.tag_names)))
    return out


def _escape(s: str | None) -> str:
    if not s:
        return ""
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _cover(track: TrackMeta, outline: dict[str, Any] | None, lang: str, st: _Styles) -> list:
    flow: list = []
    title = track.title or track.id
    flow.append(Paragraph(_escape(title), st.title))

    sub = _track_subtitle(track)
    if sub:
        flow.append(Paragraph(_escape(sub), st.subtitle))

    for line in _metadata_lines(track, lang):
        flow.append(Paragraph(line, st.metadata))

    L = _labels(lang)
    items = (outline or {}).get("items") or []
    if items:
        flow.append(Paragraph(_escape(L["contents"]), st.section))
        for it in items:
            ts = _fmt_ts(int(it.get("start_ms") or 0))
            title_text = _escape(str(it.get("title") or "").strip())
            if not title_text:
                continue
            # Two-column layout via tab — `<font name=Courier>` for the
            # mono timecode keeps it the same width across items.
            flow.append(Paragraph(
                f'<font name="{MONO_FONT}" color="#888888">{ts}</font>'
                f"&nbsp;&nbsp;{title_text}",
                st.outline_item,
            ))
        # With an outline, the body emits its own section headings derived
        # from outline items — a separate "Транскрипт" h1 above the first
        # one is redundant and produces a visible empty gap.
    else:
        flow.append(Spacer(1, 6 * mm))
        flow.append(Paragraph(_escape(L["transcript"]), st.section))
    return flow


# ---------------------------------------------------------------------------
# Body — outline-anchored sections + sentence-count / char paragraph splits.
# ---------------------------------------------------------------------------


# Soft caps on the size of a single rendered paragraph. The walker
# flushes whichever fires first; the explicit `paragraph` block from
# the transcript and any outline boundary still trump these. Chosen by
# eye on real Prabhupāda transcripts: a typical reflective beat is
# 3–5 sentences, an emphatic point can sprawl past 600 chars.
_MAX_PARA_SENTENCES = 4
_MAX_PARA_CHARS = 600


def _section_items(outline: dict[str, Any] | None) -> list[tuple[int, str]]:
    """Project the outline payload into `(start_ms, title)` pairs sorted
    by start_ms. Empty list when no outline is available."""
    items = (outline or {}).get("items") or []
    cleaned: list[tuple[int, str]] = []
    for it in items:
        title = str(it.get("title") or "").strip()
        if not title:
            continue
        cleaned.append((int(it.get("start_ms") or 0), title))
    cleaned.sort(key=lambda p: p[0])
    return cleaned


def _body(
    transcript: dict[str, Any],
    outline: dict[str, Any] | None,
    st: _Styles,
) -> list:
    """Walk the transcript blocks once, emitting Platypus flowables.

    Paragraph boundaries: `paragraph` blocks (explicit author intent),
    crossing an outline section boundary, hitting `_MAX_PARA_SENTENCES`,
    or `_MAX_PARA_CHARS`. Verses (with optional translation) flush the
    current paragraph and render with their own styling.

    Section headings (outline-derived) drop into the flow at the first
    block whose start crosses each item's `start_ms`. They render with
    a small leading timecode so the reader can scrub straight to that
    section from a printed copy.
    """
    raw_blocks: Iterable[dict[str, Any]] = transcript.get("blocks") or []
    sections = _section_items(outline)
    section_idx = 0  # next pending outline item to emit

    flow: list = []
    sentence_buf: list[tuple[int, str]] = []  # (start_ms, text)
    char_count = 0

    def flush_paragraph() -> None:
        nonlocal char_count
        if not sentence_buf:
            return
        start_ms = sentence_buf[0][0]
        text = " ".join(t for _, t in sentence_buf if t).strip()
        sentence_buf.clear()
        char_count = 0
        if not text:
            return
        ts = _fmt_ts(start_ms)
        flow.append(KeepTogether([
            Paragraph(
                f'<font name="{MONO_FONT}" color="#888888">[{ts}]</font>',
                st.timecode,
            ),
            Paragraph(_escape(text), st.body),
        ]))

    def maybe_emit_sections(up_to_ms: int) -> None:
        """Drain any outline section whose anchor we've crossed.

        The heading itself carries no timecode — the next paragraph
        always emits its own `[MM:SS]` chip right under it, so a
        timecode in the heading would just duplicate the one below.
        The TOC on the cover keeps timecodes so the reader can locate
        sections without scanning the body.
        """
        nonlocal section_idx
        while section_idx < len(sections) and up_to_ms >= sections[section_idx][0]:
            _sec_ms, sec_title = sections[section_idx]
            flush_paragraph()
            flow.append(Paragraph(_escape(sec_title), st.section_body))
            section_idx += 1

    for b in raw_blocks:
        t = b.get("type")
        b_start = int(b.get("start") or 0)
        maybe_emit_sections(b_start)

        if t == "paragraph":
            flush_paragraph()
            continue
        if t == "sentence":
            text = b.get("text")
            if not isinstance(text, str):
                continue
            text = text.strip()
            if not text:
                continue
            sentence_buf.append((b_start, text))
            char_count += len(text) + 1
            if len(sentence_buf) >= _MAX_PARA_SENTENCES or char_count >= _MAX_PARA_CHARS:
                flush_paragraph()
            continue
        if t == "verse:text":
            flush_paragraph()
            lines = b.get("text")
            verse_lines: list[str] = []
            if isinstance(lines, list):
                for line in lines:
                    if isinstance(line, str) and line.strip():
                        verse_lines.append(_escape(line.strip()))
            elif isinstance(lines, str) and lines.strip():
                verse_lines = [_escape(lines.strip())]
            if not verse_lines:
                continue
            ts = _fmt_ts(b_start)
            flow.append(Paragraph(
                f'<font name="{MONO_FONT}" color="#888888">[{ts}]</font>',
                st.timecode,
            ))
            flow.append(Paragraph("<br/>".join(verse_lines), st.verse))
            continue
        if t == "verse:translation":
            text = b.get("text")
            if isinstance(text, str) and text.strip():
                flow.append(Paragraph(_escape(text.strip()), st.verse_translation))
            continue
        # Unknown block type — skip silently. Future transcript schema
        # additions shouldn't break PDF generation.

    flush_paragraph()
    # Drain any trailing outline items past the last block — keeps the
    # heading list complete even on a truncated transcript tail.
    maybe_emit_sections(2**31)
    return flow


# ---------------------------------------------------------------------------
# Document assembly
# ---------------------------------------------------------------------------


def _on_page(track: TrackMeta, lang: str):
    """Footer painter: page number + brand on every page."""
    L = _labels(lang)
    brand = L["footer_brand"]
    track_label = (track.title or track.id)[:80]

    def _draw(canvas, doc):
        canvas.saveState()
        canvas.setFont(BODY_FONT, 8)
        canvas.setFillColor(colors.HexColor("#999999"))
        # Bottom-left: brand + track title
        canvas.drawString(
            18 * mm, 10 * mm, f"{brand} · {track_label}",
        )
        # Bottom-right: "page X"
        canvas.drawRightString(
            A4[0] - 18 * mm, 10 * mm, f"{doc.page}",
        )
        canvas.restoreState()

    return _draw


def render_transcript_pdf(
    *,
    track: TrackMeta,
    transcript: dict[str, Any],
    outline: dict[str, Any] | None,
    lang: str,
) -> bytes:
    """Render the PDF and return its bytes.

    `lang` is the rendered transcript language (i.e. what
    `CatalogRepository.resolve_transcript_path` returned), not
    necessarily the user's preferred UI language. Labels follow `lang`
    so an English transcript reads with English chrome even in a Russian
    UI session.
    """
    register_fonts()
    st = _build_styles()

    buf = BytesIO()
    page_size = A4
    left = right = 18 * mm
    top = 18 * mm
    bottom = 18 * mm
    frame = Frame(
        left, bottom,
        page_size[0] - left - right,
        page_size[1] - top - bottom,
        id="body",
        showBoundary=0,
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc = BaseDocTemplate(
        buf,
        pagesize=page_size,
        leftMargin=left, rightMargin=right,
        topMargin=top, bottomMargin=bottom,
        title=(track.title or track.id)[:120],
        author=track.author_name or track.author_id or "",
        subject=_labels(lang)["transcript"],
        creator=_labels(lang)["footer_brand"],
    )
    doc.addPageTemplates([PageTemplate(
        id="default",
        frames=[frame],
        onPage=_on_page(track, lang),
    )])

    story: list = []
    story.extend(_cover(track, outline, lang, st))
    story.extend(_body(transcript, outline, st))
    doc.build(story)
    return buf.getvalue()


__all__ = ["render_transcript_pdf"]
