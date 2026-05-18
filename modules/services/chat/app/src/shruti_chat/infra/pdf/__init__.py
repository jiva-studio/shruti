"""PDF rendering — reportlab-based transcript export.

The chat agent's `generate_track_pdf` tool produces a printable PDF for
one lecture and uploads it to the public CDN. This package owns:

- font registration (`fonts.register_fonts`) — DejaVu Sans/Serif bundled
  alongside this module so Cyrillic + IAST diacritics render without
  relying on a system font stack
- the renderer (`render.render_transcript_pdf`) — given a `Track`, the
  raw transcript JSON, and an optional outline payload, returns the
  encoded PDF bytes
"""

from __future__ import annotations

from shruti_chat.infra.pdf.fonts import (
    BODY_FONT,
    BODY_FONT_BOLD,
    HEAD_FONT,
    HEAD_FONT_BOLD,
    MONO_FONT,
    register_fonts,
)
from shruti_chat.infra.pdf.render import render_transcript_pdf

__all__ = [
    "BODY_FONT",
    "BODY_FONT_BOLD",
    "HEAD_FONT",
    "HEAD_FONT_BOLD",
    "MONO_FONT",
    "register_fonts",
    "render_transcript_pdf",
]
