"""Deterministic IAST → target-script Sanskrit transliteration.

Each transliterator is named by its TARGET language — `iast_to_ru`
(Russian Cyrillic), `iast_to_uk` (Ukrainian Cyrillic), `iast_to_sr`
(Serbian Cyrillic). "Cyrillic" alone would be a lie: the three alphabets
differ (Ukrainian ``і``/``ґ``, Serbian ``ц``/``ј``/``џ``), so one map can't
cover them. `sr-Latn` transliteration is the IAST itself. A separate
`sr_latin_to_cyrillic` converts non-Sanskrit Serbian prose between scripts.


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


def _transliterate(text: str, table: dict[str, str], max_key: int) -> str:
    """Greedy longest-match transliteration of `text` against `table`.

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
        for size in range(min(max_key, n - i), 0, -1):
            chunk = text[i : i + size]
            repl = table.get(chunk) or table.get(chunk.lower())
            if repl is not None:
                out.append(repl)
                i += size
                matched = True
                break
        if not matched:
            out.append(text[i])
            i += 1
    return "".join(out)


def iast_to_ru(text: str) -> str:
    """Transliterate clean Latin IAST to Russian (Cyrillic) Sanskrit.

    Renamed from `iast_to_cyrillic`: "cyrillic" was a lie — Russian and
    Ukrainian/Serbian Cyrillic are different alphabets with different
    conventions, so we name each transliterator by its TARGET language.
    """
    return _transliterate(text, _MAP, _MAX_KEY)


# ── Ukrainian (Cyrillic) ────────────────────────────────────────────────
# Ukrainian Vaiṣṇava transliteration. The base differs from Russian on a
# handful of letters that exist only in the Ukrainian alphabet:
#   * ``i`` → ``і`` (U+0456, Ukrainian dotted i — not Russian ``и``)
#   * ``e`` → ``е`` while iotated ``je`` would be ``є`` (rare in IAST)
#   * ``g`` → ``ґ`` (U+0491 ghe-with-upturn, the hard g; Ukrainian ``г`` is /h/)
#   * ``h`` → ``г`` (Ukrainian ``г`` is the /h/ sound, matching Sanskrit h)
# All diacritic/retroflex conventions are inherited from the Russian map.
_MAP_UK: dict[str, str] = dict(_MAP)
_MAP_UK.update({
    "i": "і",
    "ī": "і" + _MACRON,
    "g": "ґ",
    "gh": "ґх",
    "h": "г",
    "ḥ": "г" + _DOT_BELOW,
})
_KEYS_UK = sorted(_MAP_UK, key=len, reverse=True)
_MAX_KEY_UK = len(_KEYS_UK[0])


def iast_to_uk(text: str) -> str:
    """Transliterate clean Latin IAST to Ukrainian (Cyrillic) Sanskrit."""
    return _transliterate(text, _MAP_UK, _MAX_KEY_UK)


# ── Serbian (Cyrillic) ──────────────────────────────────────────────────
# Serbian Cyrillic is a strict 1:1 mapping from Serbian Latin (Gajica),
# so Sanskrit IAST → Serbian Cyrillic follows the Serbian letter values:
#   * ``c`` → ``ц`` (Serbian c is /ts/, NOT Russian ``ч``)
#   * ``j`` → ``ј`` (Serbian je/jat letter, a single glyph — not ``дж``)
#   * ``y`` → ``ј``  ``h`` → ``х``  ``v`` → ``в``
#   * ``ś`` / ``ṣ`` → ``ш``;  ``c`` aspirates use ``ч`` only where IAST ``ch``
# Diacritics for long vowels / retroflex dots reuse the combining marks.
_MAP_SR: dict[str, str] = {
    # vowels
    "ā": "а" + _MACRON,
    "ī": "и" + _MACRON,
    "ū": "у" + _MACRON,
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
    # aspirated stops
    "kh": "кх",
    "gh": "гх",
    "ch": "чх",
    "jh": "џх",
    "ṭh": "т" + _DOT_BELOW + "х",
    "ḍh": "д" + _DOT_BELOW + "х",
    "th": "тх",
    "dh": "дх",
    "ph": "пх",
    "bh": "бх",
    # consonants with diacritics
    "ṅ": "н" + _DOT_ABOVE,
    "ñ": "њ",
    "ṇ": "н" + _DOT_BELOW,
    "ṭ": "т" + _DOT_BELOW,
    "ḍ": "д" + _DOT_BELOW,
    "ś": "ш" + _ACUTE,
    "ṣ": "ш",
    "ḥ": "х" + _DOT_BELOW,
    "ṁ": "м" + _DOT_ABOVE,
    "ṃ": "м" + _DOT_ABOVE,
    # plain consonants — Serbian letter values
    "k": "к",
    "g": "г",
    "c": "ц",
    "j": "џ",
    "t": "т",
    "d": "д",
    "n": "н",
    "p": "п",
    "b": "б",
    "m": "м",
    "y": "ј",
    "r": "р",
    "l": "л",
    "v": "в",
    "s": "с",
    "h": "х",
}
_KEYS_SR = sorted(_MAP_SR, key=len, reverse=True)
_MAX_KEY_SR = len(_KEYS_SR[0])


def iast_to_sr(text: str) -> str:
    """Transliterate clean Latin IAST to Serbian (Cyrillic) Sanskrit.

    `sr-Latn` transliteration is the IAST itself (Latin script), so only
    `sr-Cyrl` needs this conversion.
    """
    return _transliterate(text, _MAP_SR, _MAX_KEY_SR)


# ── Serbian Latin → Cyrillic (NON-Sanskrit prose / UI strings) ──────────
# Deterministic 1:1 Gajica ↔ Serbian Cyrillic map. Used to derive the
# `sr-Cyrl` rendering of any Serbian Latin string (synthesizer prose,
# MT-translated citations, UI copy) without a second authoring pass —
# Serbian's two scripts are perfectly interconvertible. Digraphs first.
_SR_LATIN_MAP: dict[str, str] = {
    # digraphs (must match before their leading single letter)
    "Lj": "Љ", "LJ": "Љ", "lj": "љ",
    "Nj": "Њ", "NJ": "Њ", "nj": "њ",
    "Dž": "Џ", "DŽ": "Џ", "dž": "џ",
    # single letters
    "A": "А", "B": "Б", "V": "В", "G": "Г", "D": "Д", "Đ": "Ђ",
    "E": "Е", "Ž": "Ж", "Z": "З", "I": "И", "J": "Ј", "K": "К",
    "L": "Л", "M": "М", "N": "Н", "O": "О", "P": "П", "R": "Р",
    "S": "С", "T": "Т", "Ć": "Ћ", "U": "У", "F": "Ф", "H": "Х",
    "C": "Ц", "Č": "Ч", "Š": "Ш",
    "a": "а", "b": "б", "v": "в", "g": "г", "d": "д", "đ": "ђ",
    "e": "е", "ž": "ж", "z": "з", "i": "и", "j": "ј", "k": "к",
    "l": "л", "m": "м", "n": "н", "o": "о", "p": "п", "r": "р",
    "s": "с", "t": "т", "ć": "ћ", "u": "у", "f": "ф", "h": "х",
    "c": "ц", "č": "ч", "š": "ш",
}
_SR_LATIN_KEYS = sorted(_SR_LATIN_MAP, key=len, reverse=True)
_SR_LATIN_MAX_KEY = len(_SR_LATIN_KEYS[0])


def sr_latin_to_cyrillic(text: str) -> str:
    """Convert Serbian Latin (Gajica) to Serbian Cyrillic, 1:1.

    Case-sensitive (preserves the source case): unlike the IAST maps this
    runs over natural-language prose where capitalisation matters. Unmapped
    characters (digits, punctuation, already-Cyrillic) pass through.
    """
    if not text:
        return text
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        matched = False
        for size in range(min(_SR_LATIN_MAX_KEY, n - i), 0, -1):
            chunk = text[i : i + size]
            repl = _SR_LATIN_MAP.get(chunk)
            if repl is not None:
                out.append(repl)
                i += size
                matched = True
                break
        if not matched:
            out.append(text[i])
            i += 1
    return "".join(out)
