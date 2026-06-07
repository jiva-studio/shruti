"""Deterministic IAST → Russian (Cyrillic) Sanskrit transliteration.

`library.db.library_verses.transliteration` is clean Latin IAST (e.g.
``dhṛtarāṣṭra uvāca``) and is the single source of truth. The mobile app
shows a Cyrillic transliteration for the Russian locale, so we DERIVE it
here rather than importing the gitabase ``ru.translit`` column (which is
HTML + Private-Use-Area-encoded garbage and has already produced
corrupted rows in the corpus).

The target convention is the Russian Vaiṣṇava / ISKCON-BBT scheme with
COMBINING diacritics, validated codepoint-for-codepoint against the one
known-good row in the corpus (CC Madhya 12.221)::

    guṇḍicā-mārjana-līlā saṅkṣepe kahila
    → гун̣д̣ича̄-ма̄рджана-лӣла̄ сан̇кшепе кахила

Notable choices (verified against that row + the BG 1.x region):

* long ``ā`` → ``а`` + U+0304 COMBINING MACRON  (NOT precomposed ӓ/а̄ char)
* ``ī`` → ``ӣ`` (U+04E3, precomposed)   ``ū`` → ``ӯ`` (U+04EF, precomposed)
* vocalic ``ṛ`` → ``р`` + U+0323 COMBINING DOT BELOW
* retroflex/nasal dots use combining marks: ``ṇ`` → ``н``+U+0323,
  ``ṭ`` → ``т``+U+0323, ``ḍ`` → ``д``+U+0323
* ``ṅ`` → ``н`` + U+0307 (dot above)   ``ñ`` → ``н`` + U+0303 (tilde)
* ``ś`` → ``ш`` + U+0301 (acute)   ``ṣ`` → ``ш`` (plain)
* ``ḥ`` → ``х`` + U+0323   ``ṁ`` / ``ṃ`` → ``м`` + U+0307
* ``c`` → ``ч``  ``j`` → ``дж``  ``y`` → ``й``  ``v`` → ``в``  ``h`` → ``х``
* aspirated digraphs map to the plain consonant + ``х`` (``kh`` → ``кх`` …)

The function is robust to non-IAST input: any character with no mapping
(already-Cyrillic text, punctuation, digits, stray garbage) is passed
through unchanged, so it never raises on the 9 known-corrupted source
rows — it just leaves them alone.
"""

from __future__ import annotations

import unicodedata


# Combining diacritics (applied after the base Cyrillic letter).
_MACRON = "̄"        # ̄  long vowel
_DOT_ABOVE = "̇"     # ̇  anusvāra / ṅ
_DOT_BELOW = "̣"     # ̣  retroflex / vocalic r-l / visarga
_ACUTE = "́"         # ́  ś
_TILDE = "̃"         # ̃  ñ


# IAST → Cyrillic, longest-key-first. Digraphs and aspirated stops MUST
# be matched before their leading single letter (kh before k, etc.),
# which the longest-first sort below guarantees.
#
# Vowels first, then consonant clusters, then single consonants.
_MAP: dict[str, str] = {
    # ── vowels ──────────────────────────────────────────────────────
    "ā": "а" + _MACRON,
    "ī": "ӣ",                       # U+04E3
    "ū": "ӯ",                       # U+04EF
    "ṝ": "р" + _DOT_BELOW + _MACRON,
    "ṛ": "р" + _DOT_BELOW,
    "ḹ": "л" + _DOT_BELOW + _MACRON,
    "ḷ": "л" + _DOT_BELOW,
    "ai": "аи",
    "au": "ау",
    "a": "а",
    "i": "и",
    "u": "у",
    "e": "е",
    "o": "о",
    # ── aspirated stops (digraphs — match before the bare consonant) ──
    "kh": "кх",
    "gh": "гх",
    "ch": "чх",
    "jh": "джх",
    "ṭh": "т" + _DOT_BELOW + "х",
    "ḍh": "д" + _DOT_BELOW + "х",
    "th": "тх",
    "dh": "дх",
    "ph": "пх",
    "bh": "бх",
    # ── consonants with diacritics ──────────────────────────────────
    "ṅ": "н" + _DOT_ABOVE,
    "ñ": "н" + _TILDE,
    "ṇ": "н" + _DOT_BELOW,
    "ṭ": "т" + _DOT_BELOW,
    "ḍ": "д" + _DOT_BELOW,
    "ś": "ш" + _ACUTE,
    "ṣ": "ш",
    "ḥ": "х" + _DOT_BELOW,
    "ṁ": "м" + _DOT_ABOVE,
    "ṃ": "м" + _DOT_ABOVE,
    # ── plain consonants ────────────────────────────────────────────
    "k": "к",
    "g": "г",
    "c": "ч",
    "j": "дж",
    "ṭ": "т" + _DOT_BELOW,
    "t": "т",
    "d": "д",
    "n": "н",
    "p": "п",
    "b": "б",
    "m": "м",
    "y": "й",
    "r": "р",
    "l": "л",
    "v": "в",
    "s": "с",
    "h": "х",
}


# Match keys longest-first so digraphs (kh, ai, …) win over single chars.
_KEYS = sorted(_MAP, key=len, reverse=True)
_MAX_KEY = len(_KEYS[0])


def iast_to_cyrillic(text: str) -> str:
    """Transliterate clean Latin IAST to Russian (Cyrillic) Sanskrit.

    Case-insensitive on the source (the corpus transliteration is
    lower-case; the few capitalised English fragments map by their
    lower-cased form and lose case — acceptable for verse bodies).
    Unmapped characters (punctuation, hyphens, newlines, digits,
    already-Cyrillic text) pass through verbatim, so the function never
    raises on non-IAST / corrupted input.
    """
    if not text:
        return text

    # Normalise to NFC so combining-mark sequences in the *source* (rare:
    # 26 stray U+0323 in the corpus) fold into their precomposed IAST
    # letter and hit the table instead of leaking through unmapped.
    text = unicodedata.normalize("NFC", text)

    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        matched = False
        # Greedy longest match up to the longest table key.
        for size in range(min(_MAX_KEY, n - i), 0, -1):
            chunk = text[i : i + size]
            repl = _MAP.get(chunk) or _MAP.get(chunk.lower())
            if repl is not None:
                out.append(repl)
                i += size
                matched = True
                break
        if not matched:
            out.append(text[i])
            i += 1
    return "".join(out)
