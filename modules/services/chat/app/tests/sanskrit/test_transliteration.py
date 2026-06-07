"""IAST → Russian-Cyrillic transliteration tests.

The expected strings are spelled out with explicit combining-mark escapes
(̄ macron, ̣ dot-below, ̇ dot-above, ́ acute,
̃ tilde) so the assertions are unambiguous about the exact codepoint
sequence — matching the Russian Vaiṣṇava / ISKCON-BBT convention verified
against the one known-good corpus row (CC Madhya 12.221).
"""

import unicodedata

import pytest

from shruti_chat.sanskrit import iast_to_cyrillic

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
    assert iast_to_cyrillic(iast) == expected


def test_bg_1_1_dhrtarastra():
    assert iast_to_cyrillic("dhṛtarāṣṭra uvāca") == (
        "дхр" + DOT_BELOW + "тара" + MACRON + "шт" + DOT_BELOW + "ра ува" + MACRON + "ча"
    )


def test_long_vowels():
    # ā → а + macron ; ī → ӣ (precomposed) ; ū → ӯ (precomposed)
    assert iast_to_cyrillic("ā") == "а" + MACRON
    assert iast_to_cyrillic("ī") == "ӣ"
    assert ord(iast_to_cyrillic("ī")) == 0x04E3
    assert iast_to_cyrillic("ū") == "ӯ"
    assert ord(iast_to_cyrillic("ū")) == 0x04EF


def test_vocalic_r_and_l():
    assert iast_to_cyrillic("ṛ") == "р" + DOT_BELOW
    assert iast_to_cyrillic("ṝ") == "р" + DOT_BELOW + MACRON
    assert iast_to_cyrillic("ḷ") == "л" + DOT_BELOW


def test_nasals():
    assert iast_to_cyrillic("ṅ") == "н" + DOT_ABOVE   # guttural
    assert iast_to_cyrillic("ñ") == "н" + TILDE        # palatal
    assert iast_to_cyrillic("ṇ") == "н" + DOT_BELOW    # retroflex
    assert iast_to_cyrillic("ṁ") == "м" + DOT_ABOVE    # anusvāra
    assert iast_to_cyrillic("ṃ") == "м" + DOT_ABOVE    # alt anusvāra


def test_sibilants():
    assert iast_to_cyrillic("ś") == "ш" + ACUTE   # palatal
    assert iast_to_cyrillic("ṣ") == "ш"           # retroflex (plain)
    assert iast_to_cyrillic("s") == "с"           # dental


def test_visarga():
    assert iast_to_cyrillic("ḥ") == "х" + DOT_BELOW


def test_retroflex_stops():
    assert iast_to_cyrillic("ṭ") == "т" + DOT_BELOW
    assert iast_to_cyrillic("ḍ") == "д" + DOT_BELOW
    assert iast_to_cyrillic("ṭha") == "т" + DOT_BELOW + "ха"
    assert iast_to_cyrillic("ḍha") == "д" + DOT_BELOW + "ха"


def test_aspirated_digraphs_beat_single_letters():
    # The greedy longest-match must take the digraph, not k + h.
    assert iast_to_cyrillic("kha") == "кха"
    assert iast_to_cyrillic("gha") == "гха"
    assert iast_to_cyrillic("cha") == "чха"
    assert iast_to_cyrillic("jha") == "джха"
    assert iast_to_cyrillic("tha") == "тха"
    assert iast_to_cyrillic("dha") == "дха"
    assert iast_to_cyrillic("pha") == "пха"
    assert iast_to_cyrillic("bha") == "бха"


def test_palatal_consonants():
    assert iast_to_cyrillic("ca") == "ча"
    assert iast_to_cyrillic("ja") == "джа"
    assert iast_to_cyrillic("ya") == "йа"


def test_diphthongs():
    assert iast_to_cyrillic("ai") == "аи"
    assert iast_to_cyrillic("au") == "ау"
    assert iast_to_cyrillic("caiva") == "чаива"


def test_v_h_consonants():
    assert iast_to_cyrillic("uvāca") == "ува" + MACRON + "ча"
    assert iast_to_cyrillic("haila") == "хаила"


def test_krsna_kirtana_spot_checks():
    assert iast_to_cyrillic("kṛṣṇa") == "кр" + DOT_BELOW + "шн" + DOT_BELOW + "а"
    # govinda — all plain
    assert iast_to_cyrillic("govinda") == "говинда"


def test_punctuation_and_hyphen_passthrough():
    assert iast_to_cyrillic("hare-kṛṣṇa, hare!") == (
        "харе-кр" + DOT_BELOW + "шн" + DOT_BELOW + "а, харе!"
    )
    assert iast_to_cyrillic("a\nb") == "а\nб"


def test_empty_and_none_like():
    assert iast_to_cyrillic("") == ""


def test_robust_to_already_cyrillic_input():
    # The 9 corrupted rows are NOT touched by us, but the function must
    # not crash if a Cyrillic/garbage string is ever fed in — it passes
    # unmapped chars through verbatim.
    garbage = "śаунака увāча\nхатвā свариктха"
    out = iast_to_cyrillic(garbage)
    assert isinstance(out, str)
    # Cyrillic stays; the stray Latin ś/ā get transliterated, nothing raises.
    assert "ауна" in out  # śа -> ш́а ... 'ауна' substring survives


def test_digits_punctuation_passthrough_and_caps_lowercased():
    # Digits / dots / spaces are unmapped → pass through verbatim.
    # Capitals are transliterated by their lower-cased form (the only
    # capitals in the corpus are sentence-start IAST), so "BG" → "бг".
    assert iast_to_cyrillic("2.13") == "2.13"
    assert iast_to_cyrillic("BG") == "бг"
    assert iast_to_cyrillic("bg") == "бг"


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
    out = unicodedata.normalize("NFC", iast_to_cyrillic(iast))
    leaked = [c for c in out if "LATIN" in (unicodedata.name(c, ""))]
    assert leaked == [], f"latin leaked through: {leaked}"
