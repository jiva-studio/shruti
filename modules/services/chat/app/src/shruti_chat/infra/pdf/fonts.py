"""Font registration for the PDF renderer.

reportlab ships with Helvetica/Times/Courier, none of which embed
Cyrillic glyphs. We ship DejaVu (vendored TTF under `./fonts/`) and
register it as both the body family and a Serif headline family. A
single `register_fonts()` call at startup is idempotent — repeated
calls are a no-op because reportlab's font registry rejects duplicates.
"""

from __future__ import annotations

from pathlib import Path
from threading import Lock

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping


BODY_FONT = "ShrutiSans"
BODY_FONT_BOLD = "ShrutiSans-Bold"
HEAD_FONT = "ShrutiSerif"
HEAD_FONT_BOLD = "ShrutiSerif-Bold"
# reportlab's Courier covers ASCII timecodes well enough; we don't need
# a Unicode mono face for `[HH:MM:SS]` markers.
MONO_FONT = "Courier"


_FONTS_DIR = Path(__file__).parent / "fonts"

_REGISTERED = False
_LOCK = Lock()


def register_fonts() -> None:
    """Register the bundled DejaVu faces with reportlab.

    Safe to call multiple times — guarded by a module-level flag.
    """
    global _REGISTERED
    with _LOCK:
        if _REGISTERED:
            return
        pdfmetrics.registerFont(TTFont(BODY_FONT, str(_FONTS_DIR / "DejaVuSans.ttf")))
        pdfmetrics.registerFont(
            TTFont(BODY_FONT_BOLD, str(_FONTS_DIR / "DejaVuSans-Bold.ttf")),
        )
        pdfmetrics.registerFont(
            TTFont(f"{BODY_FONT}-Oblique", str(_FONTS_DIR / "DejaVuSans-Oblique.ttf")),
        )
        pdfmetrics.registerFont(TTFont(
            f"{BODY_FONT}-BoldOblique",
            str(_FONTS_DIR / "DejaVuSans-BoldOblique.ttf"),
        ))
        pdfmetrics.registerFont(TTFont(HEAD_FONT, str(_FONTS_DIR / "DejaVuSerif.ttf")))
        pdfmetrics.registerFont(
            TTFont(HEAD_FONT_BOLD, str(_FONTS_DIR / "DejaVuSerif-Bold.ttf")),
        )

        # Style mapping lets reportlab pick the bold/italic face from a
        # base family name automatically — needed for inline <b>/<i>
        # markup in Paragraph text.
        addMapping(BODY_FONT, 0, 0, BODY_FONT)
        addMapping(BODY_FONT, 1, 0, BODY_FONT_BOLD)
        addMapping(BODY_FONT, 0, 1, f"{BODY_FONT}-Oblique")
        addMapping(BODY_FONT, 1, 1, f"{BODY_FONT}-BoldOblique")
        addMapping(HEAD_FONT, 0, 0, HEAD_FONT)
        addMapping(HEAD_FONT, 1, 0, HEAD_FONT_BOLD)

        _REGISTERED = True
