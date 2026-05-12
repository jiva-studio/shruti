"""ScaGoudy custom encoding -> proper IAST -> ASCII fold.

The Sanskrit-using PDFs use a legacy font (ScaGoudy and friends) where IAST
diacritics are mapped onto Latin-1 characters with combining accents:
  ä -> ā      é -> ī      ü -> ū
  å -> ṛ      ñ -> ṣ      ë -> ṇ      ì -> ṅ
  ö -> ṭ      ò -> ḍ      ç -> ś      à -> ṁ      ù -> ḥ
We keep this best-effort; unknown glyphs are passed through so they don't
silently corrupt output. ASCII fold strips diacritics for fuzzy matching.
"""
from __future__ import annotations
import unicodedata, re

# best-effort mapping derived from observed PDF text vs known IAST forms
SCA_TO_IAST = {
    # long vowels
    "ä": "ā", "Ä": "Ā",
    "é": "ī", "É": "Ī",
    "ü": "ū", "Ü": "Ū",
    # vocalic R (no vocalic L observed yet)
    "å": "ṛ", "Å": "Ṛ",
    # palatal/retroflex Ns
    "ì": "ṅ", "Ì": "Ṅ",   # velar
    "ï": "ñ", "Ï": "Ñ",   # palatal (ñ)
    "ë": "ṇ", "Ë": "Ṇ",   # retroflex
    # retroflex T/D
    "ö": "ṭ", "Ö": "Ṭ",
    "ò": "ḍ", "Ò": "Ḍ",
    # sibilants — NOTE: in this font, ñ encodes ṣ (not ñ-tilde)
    "ç": "ś", "Ç": "Ś",
    "ñ": "ṣ", "Ñ": "Ṣ",
    # anusvara / visarga
    "à": "ṁ", "À": "Ṁ",
    "ù": "ḥ", "Ù": "Ḥ",
}

def to_iast(text: str) -> str:
    """Convert ScaGoudy-encoded Sanskrit to proper IAST diacritics."""
    return "".join(SCA_TO_IAST.get(ch, ch) for ch in text)

_combining_re = re.compile(r"[̀-ͯ]")

def ascii_fold(text: str) -> str:
    """Lowercase, strip diacritics, normalize whitespace, drop punct.
    Used for fuzzy matching against ASR text."""
    s = to_iast(text)
    s = unicodedata.normalize("NFD", s)
    s = _combining_re.sub("", s)
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s']", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def tokens(text: str) -> list[str]:
    return ascii_fold(text).split()
