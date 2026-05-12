"""Map PDF citation tokens (e.g. 'Bg 8.12', 'Cc Madhya 6.154') to canonical
source IDs in the lectorium DB.

The canonical IDs come from `mcp__lectorium__source_list` (snapshot 2026-05).
Sources not present in the DB resolve to None — caller decides whether to
keep the raw label or drop the reference.
"""
from __future__ import annotations
import re

# canonical source IDs from DB
SRC_BG       = "source_dsicuBsFvinZ"   # Bhagavad-gita
SRC_SB       = "source_NoY8sAlXF1IT"   # Srimad-Bhagavatam
SRC_BS       = "source_SJCHFywxayrT"   # Brahma-samhita
SRC_ISO      = "source_mA0FlWmbt5K0"   # Sri Isopanisad
SRC_NOD      = "source_5hQKMNbazMqW"   # Nectar of Devotion
SRC_CC_ADI   = "source_0OX6Db6QpdJ4"   # Caitanya-caritamrta, Adi-lila
SRC_CC_MAD   = "source_TjXzVgg41Z4s"   # Caitanya-caritamrta, Madhya-lila
SRC_CC_ANTYA = "source_CMkOCwD0GDQF"   # Caitanya-caritamrta, Antya-lila

# Patterns for inline PDF citations. Captures (raw_source, raw_tokens).
INLINE_REF_RE = re.compile(
    r"\[("
        r"Bg|SB|Bs|Iso|NoI|NoD|MM|TLC|NBS|Hari|Brs|MoI|"
        r"Cc\.?\s*(?:Ädi|Adi|Madhya|Antya)|"
        r"BG|CC"
    r")\.?\s*([^\]]+?)\]",
    re.IGNORECASE,
)

def resolve(raw_source: str, raw_tokens: str | None = None) -> tuple[str | None, str]:
    """Return (canonical_source_id_or_None, normalized_tokens)."""
    if not raw_source: return (None, raw_tokens or "")
    s = raw_source.strip()
    s = re.sub(r"[._]+", " ", s)
    s = re.sub(r"\s+", " ", s).lower().strip()
    tokens = (raw_tokens or "").strip()

    # Cc + lila handling: parser may emit ("Cc Madhya", "6.154") or
    # ("Cc", "Madhya 6.154") or ("Cc", ". Madhya 6.154"). Normalize.
    if s == "cc":
        m = re.match(r"^[.\s]*(ädi|adi|madhya|antya)\b\s*(.*)$", tokens, re.IGNORECASE)
        if m:
            s = "cc " + m.group(1).lower().replace("ä", "a")
            tokens = m.group(2).strip()
    else:
        m = re.match(r"^(cc\s+(?:ädi|adi|madhya|antya))\b\s*(.*)$", s)
        if m:
            s = m.group(1).strip()
            tail = m.group(2).strip()
            if tail and not tokens:
                tokens = tail

    if s in ("bg",):                    return (SRC_BG, tokens)
    if s in ("sb", "srimad bhagavatam","śrīmad-bhāgavatam"):
                                        return (SRC_SB, tokens)
    if s in ("bs",):                    return (SRC_BS, tokens)
    if s in ("iso",):                   return (SRC_ISO, tokens)
    if s in ("nod","nectar of devotion"): return (SRC_NOD, tokens)
    if s in ("cc adi","cc ädi"):        return (SRC_CC_ADI, tokens)
    if s in ("cc madhya",):             return (SRC_CC_MAD, tokens)
    if s in ("cc antya",):              return (SRC_CC_ANTYA, tokens)
    return (None, tokens)

def find_inline(text: str) -> list[tuple[int, int, str | None, str, str]]:
    """Find all inline [Source X.Y] citations in `text`.
    Returns list of (start, end, canonical_source_id, raw_source, normalized_tokens)."""
    out = []
    for m in INLINE_REF_RE.finditer(text):
        raw_src = m.group(1)
        raw_tok = m.group(2).strip().rstrip(",;: ")
        canon, tokens = resolve(raw_src, raw_tok)
        out.append((m.start(), m.end(), canon, raw_src, tokens))
    return out
