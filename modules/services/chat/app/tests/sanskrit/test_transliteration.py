"""IAST → Russian-Cyrillic transliteration tests.

The expected strings are spelled out with explicit combining-mark escapes
(̄ macron, ̣ dot-below, ̇ dot-above, ́ acute,
̃ tilde) so the assertions are unambiguous about the exact codepoint
sequence — matching the Russian Vaiṣṇava / ISKCON-BBT convention verified
against the one known-good corpus row (CC Madhya 12.221).
"""

import unicodedata

import pytest

from shruti_chat.sanskrit import (
    iast_to_ru,
    iast_to_sr,
    iast_to_uk,
    sr_latin_to_cyrillic,
)

MACRON = "̄"
DOT_BELOW = "̣"
DOT_ABOVE = "̇"
ACUTE = "́"
TILDE = "̃"


def test_known_good_corpus_row_exact():
    """The single clean Cyrillic row in the corpus — codepoint exact."""
    iast = (
        "guṇḍicā-mārjana-līlā saṅkṣepe kahila\n"
        "yāhā dekhi’ śuni’ pāpīra kṛṣṇa-bhakti haila"
    )
    expected = (
        "гун̣д̣ича̄-ма̄рджана-лӣла̄ сан̇кшепе кахила\n"
        "йа̄ха̄ декхи’ ш́уни’ па̄пӣра кр̣шн̣а-бхакти хаила"
    )
    assert iast_to_ru(iast) == expected


def test_bg_1_1_dhrtarastra():
    assert iast_to_ru("dhṛtarāṣṭra uvāca") == (
        "дхр" + DOT_BELOW + "тара" + MACRON + "шт" + DOT_BELOW + "ра ува" + MACRON + "ча"
    )


def test_long_vowels():
    # ā → а + macron ; ī → ӣ (precomposed) ; ū → ӯ (precomposed)
    assert iast_to_ru("ā") == "а" + MACRON
    assert iast_to_ru("ī") == "ӣ"
    assert ord(iast_to_ru("ī")) == 0x04E3
    assert iast_to_ru("ū") == "ӯ"
    assert ord(iast_to_ru("ū")) == 0x04EF


def test_vocalic_r_and_l():
    assert iast_to_ru("ṛ") == "р" + DOT_BELOW
    assert iast_to_ru("ṝ") == "р" + DOT_BELOW + MACRON
    assert iast_to_ru("ḷ") == "л" + DOT_BELOW


def test_nasals():
    assert iast_to_ru("ṅ") == "н" + DOT_ABOVE   # guttural
    assert iast_to_ru("ñ") == "н" + TILDE        # palatal
    assert iast_to_ru("ṇ") == "н" + DOT_BELOW    # retroflex
    assert iast_to_ru("ṁ") == "м" + DOT_ABOVE    # anusvāra
    assert iast_to_ru("ṃ") == "м" + DOT_ABOVE    # alt anusvāra


def test_sibilants():
    assert iast_to_ru("ś") == "ш" + ACUTE   # palatal
    assert iast_to_ru("ṣ") == "ш"           # retroflex (plain)
    assert iast_to_ru("s") == "с"           # dental


def test_visarga():
    assert iast_to_ru("ḥ") == "х" + DOT_BELOW


def test_retroflex_stops():
    assert iast_to_ru("ṭ") == "т" + DOT_BELOW
    assert iast_to_ru("ḍ") == "д" + DOT_BELOW
    assert iast_to_ru("ṭha") == "т" + DOT_BELOW + "ха"
    assert iast_to_ru("ḍha") == "д" + DOT_BELOW + "ха"


def test_aspirated_digraphs_beat_single_letters():
    # The greedy longest-match must take the digraph, not k + h.
    assert iast_to_ru("kha") == "кха"
    assert iast_to_ru("gha") == "гха"
    assert iast_to_ru("cha") == "чха"
    assert iast_to_ru("jha") == "джха"
    assert iast_to_ru("tha") == "тха"
    assert iast_to_ru("dha") == "дха"
    assert iast_to_ru("pha") == "пха"
    assert iast_to_ru("bha") == "бха"


def test_palatal_consonants():
    assert iast_to_ru("ca") == "ча"
    assert iast_to_ru("ja") == "джа"
    assert iast_to_ru("ya") == "йа"


def test_diphthongs():
    assert iast_to_ru("ai") == "аи"
    assert iast_to_ru("au") == "ау"
    assert iast_to_ru("caiva") == "чаива"


def test_v_h_consonants():
    assert iast_to_ru("uvāca") == "ува" + MACRON + "ча"
    assert iast_to_ru("haila") == "хаила"


def test_krsna_kirtana_spot_checks():
    assert iast_to_ru("kṛṣṇa") == "кр" + DOT_BELOW + "шн" + DOT_BELOW + "а"
    # govinda — all plain
    assert iast_to_ru("govinda") == "говинда"


def test_punctuation_and_hyphen_passthrough():
    assert iast_to_ru("hare-kṛṣṇa, hare!") == (
        "харе-кр" + DOT_BELOW + "шн" + DOT_BELOW + "а, харе!"
    )
    assert iast_to_ru("a\nb") == "а\nб"


def test_empty_and_none_like():
    assert iast_to_ru("") == ""


def test_robust_to_already_cyrillic_input():
    # The 9 corrupted rows are NOT touched by us, but the function must
    # not crash if a Cyrillic/garbage string is ever fed in — it passes
    # unmapped chars through verbatim.
    garbage = "śаунака увāча\nхатвā свариктха"
    out = iast_to_ru(garbage)
    assert isinstance(out, str)
    # Cyrillic stays; the stray Latin ś/ā get transliterated, nothing raises.
    assert "ауна" in out  # śа -> ш́а ... 'ауна' substring survives


def test_digits_punctuation_passthrough_and_caps_lowercased():
    # Digits / dots / spaces are unmapped → pass through verbatim.
    # Capitals are transliterated by their lower-cased form (the only
    # capitals in the corpus are sentence-start IAST), so "BG" → "бг".
    assert iast_to_ru("2.13") == "2.13"
    assert iast_to_ru("BG") == "бг"
    assert iast_to_ru("bg") == "бг"


@pytest.mark.parametrize(
    "iast",
    [
        "dhṛtarāṣṭra uvāca",
        "guṇḍicā-mārjana-līlā",
        "oṁ namo bhagavate vāsudevāya",
        "samaḥ sarveṣu bhūteṣu",
    ],
)
def test_output_is_pure_cyrillic_plus_marks(iast):
    """No Latin letter should survive transliteration of clean IAST."""
    out = unicodedata.normalize("NFC", iast_to_ru(iast))
    leaked = [c for c in out if "LATIN" in (unicodedata.name(c, ""))]
    assert leaked == [], f"latin leaked through: {leaked}"


# ── New transliterators: uk / sr (Cyrillic) + sr Latin↔Cyrillic ──────────


def test_iast_to_uk_uses_ukrainian_letters():
    # Ukrainian dotted i, hard g (ґ), and г for the /h/ sound.
    assert iast_to_uk("i") == "і"
    assert iast_to_uk("govinda") == "ґовінда"
    assert iast_to_uk("hari") == "гарі"
    # diacritics inherited from the Russian map
    assert iast_to_uk("ṛ") == "р" + DOT_BELOW


def test_iast_to_uk_differs_from_ru_on_i_and_g():
    # A word containing i / g / h diverges between the two scripts.
    assert iast_to_uk("govinda") != iast_to_ru("govinda")
    # Ukrainian uses і where Russian uses и
    assert "і" in iast_to_uk("iti")
    assert "і" not in iast_to_ru("iti")


def test_iast_to_sr_uses_serbian_letter_values():
    # Serbian c = ц, j = џ, y = ј, ñ = њ — NOT the Russian ч/дж.
    assert iast_to_sr("ca") == "ца"
    assert iast_to_sr("ja") == "џа"
    assert iast_to_sr("ya") == "ја"
    assert iast_to_sr("govinda") == "говинда"


def test_iast_to_sr_differs_from_ru():
    assert iast_to_sr("caitanya") != iast_to_ru("caitanya")


def test_transliterators_pass_through_non_iast():
    for fn in (iast_to_uk, iast_to_sr):
        assert fn("") == ""
        assert fn("2.13") == "2.13"
        assert fn("a\nb") == fn("a") + "\n" + fn("b")


def test_sr_latin_to_cyrillic_digraphs_and_case():
    # Digraphs map to single Cyrillic glyphs.
    assert sr_latin_to_cyrillic("ljubav") == "љубав"
    assert sr_latin_to_cyrillic("njega") == "њега"
    assert sr_latin_to_cyrillic("džak") == "џак"
    # Case preserved; special letters.
    assert sr_latin_to_cyrillic("Đorđe") == "Ђорђе"
    assert sr_latin_to_cyrillic("ćao") == "ћао"
    # Round-trippable words.
    assert sr_latin_to_cyrillic("Srpski") == "Српски"


def test_sr_latin_to_cyrillic_passthrough():
    assert sr_latin_to_cyrillic("") == ""
    assert sr_latin_to_cyrillic("123 — ?") == "123 — ?"
