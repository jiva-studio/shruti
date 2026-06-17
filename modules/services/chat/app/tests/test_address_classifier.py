"""Unit tests for the deterministic AddressClassifier.

Covers the pure parse (digit normalization, separators, gates) and the
resolve+existence decision logic with injected fakes — no DB needed. The
end-to-end behaviour against the real catalog + library DBs was measured
separately (15/22 ru/en, 21/28 multilingual, 0 false positives); these
tests lock the logic in.
"""

from __future__ import annotations

import pytest

from lectorium_chat.agent.classify.address import (
    _ref_candidates,
    decide,
    parse_ref,
)


# ── pure parse ───────────────────────────────────────────────────────


def test_parse_plain_ref() -> None:
    p = parse_ref("БГ 2.13")
    assert p is not None
    assert p.booktext == "БГ"
    assert p.ref_candidates == ["2.13"]
    assert p.has_question is False
    assert p.has_alpha is True


def test_parse_bare_number_no_book() -> None:
    p = parse_ref("2.13")
    assert p is not None
    assert p.booktext == ""
    assert p.has_alpha is False
    assert p.ref_candidates == ["2.13"]


def test_parse_normalizes_devanagari_and_bengali_digits() -> None:
    assert parse_ref("गीता २.१३").ref_candidates == ["2.13"]  # Devanagari
    assert parse_ref("গীতা ২.১৩").ref_candidates == ["2.13"]  # Bengali


def test_parse_collapses_space_separator() -> None:
    assert parse_ref("ШБ 5 5 3").ref_candidates == ["5.5.3"]


def test_parse_question_gate() -> None:
    # `has_question` is now a language-neutral "?"-anywhere hint, not a
    # ru/en interrogative keyword list. An explicit question mark trips it…
    assert parse_ref("что значит BG 2.13?").has_question is True
    assert parse_ref("गीता २.१३ क्या है?").has_question is True  # any-language ?
    assert parse_ref("¿qué significa BG 2.13?").has_question is True  # inverted ¿
    # …while a keyword-only question WITHOUT a "?" is handled by the structural
    # surrounding-text gate in `decide`, not by `has_question`.
    assert parse_ref("что значит BG 2.13").has_question is False


def test_parse_counts_surrounding_tokens() -> None:
    # Bare references — just book (+ structural word) + number. Hyphens split
    # into separate tokens ("Бхагавад-гита" → 2), matching how the catalog name
    # tokenizes, so the bare-vs-verbose gate in `decide` compares fairly.
    assert parse_ref("БГ 2.13").book_token_count == 1
    assert parse_ref("Бхагавад-гита 4.18").book_token_count == 2
    assert parse_ref("Мадхья лила 17.80").book_token_count == 1  # "лила" stripped
    assert parse_ref("Шримад Бхагаватам 1.2.6").book_token_count == 2
    # Verbose requests in any language — a bunch of words around the number.
    assert parse_ref("сделай pdf лекции по БГ 4.18").book_token_count > 2
    assert parse_ref("зроби pdf по БГ 4.18").book_token_count > 2
    assert parse_ref("make a pdf of BG 4.18").book_token_count > 2
    assert parse_ref("лекции по БГ 4.18").book_token_count > 2


def test_parse_strips_structural_words() -> None:
    # "лила" between book and number must not pollute the book text.
    assert parse_ref("Мадхья лила 17.80").booktext == "Мадхья"


def test_parse_no_number_is_none() -> None:
    assert parse_ref("Расскажи про карму") is None


def test_ref_candidates_split_no_separator() -> None:
    # "213" → split-by-position candidates for the existence check to pick.
    assert _ref_candidates("213") == ["2.13", "21.3"]
    assert _ref_candidates("2.13") == ["2.13"]
    assert _ref_candidates("5.5.3") == ["5.5.3"]


# ── decide (injected fakes) ──────────────────────────────────────────


# `book_map` maps a text → resolver hits [(source_id, confidence), ...]. The
# structural bare-vs-verbose gate calls resolve_book BOTH with the full booktext
# AND with each individual booktext token, so multi-token cases supply per-token
# entries (a book-like token resolves; a surrounding word like "что"/"erkläre"
# is simply absent from the map → resolves to nothing → alien).
def _fakes(
    book_map: dict[str, list[tuple[str, float]]],
    exist: set[tuple[str, str]],
):
    async def resolve_book(text: str) -> list[tuple[str, float]]:
        return book_map.get(text, [])

    async def verse_exists(sid: str, tok: str) -> bool:
        return (sid, tok) in exist

    async def default_sources(depth: int) -> list[str]:
        return {3: ["src_sb"], 2: ["src_bg"]}.get(depth, [])

    return dict(resolve_book=resolve_book, verse_exists=verse_exists, default_sources=default_sources)


@pytest.mark.asyncio
async def test_decide_madhya_lila_resolves_unique() -> None:
    """The reference case: 'Мадхья лила 17.80' → CC Madhya 17.80, even though
    CC Adi ALSO has a 17.80 — the lila in the raw query disambiguates."""
    p = parse_ref("Мадхья лила 17.80")
    fakes = _fakes(
        {"Мадхья": [("src_ccm", 0.95)]},  # "лила" is stripped; single-token booktext
        {("src_ccm", "17.80"), ("src_cca", "17.80")},
    )
    assert await decide(p, **fakes) == ("src_ccm", "17.80")


@pytest.mark.asyncio
async def test_decide_bare_three_level_defaults_to_sb() -> None:
    p = parse_ref("1.1.1")
    fakes = _fakes({}, {("src_sb", "1.1.1")})
    assert await decide(p, **fakes) == ("src_sb", "1.1.1")


@pytest.mark.asyncio
async def test_decide_bare_two_level_defaults_to_bg() -> None:
    p = parse_ref("2.13")
    fakes = _fakes({}, {("src_bg", "2.13")})
    assert await decide(p, **fakes) == ("src_bg", "2.13")


@pytest.mark.asyncio
async def test_decide_no_separator_existence_picks_real_split() -> None:
    """'Багвадгита 213' → BG; only 2.13 exists (21.3 doesn't), so unique."""
    p = parse_ref("Багвадгита 213")
    fakes = _fakes(
        {"Багвадгита": [("src_bg", 0.82)]},  # single-token typo → bare
        {("src_bg", "2.13")},
    )
    assert await decide(p, **fakes) == ("src_bg", "2.13")


@pytest.mark.asyncio
async def test_decide_question_defers() -> None:
    """«что значит BG 2.13» — no "?", but "что"/"значит" name no book, so the
    structural surrounding-text gate defers it. (The full-booktext fuzzy resolve
    still matches BG via token_set_ratio, which is exactly why whole-booktext
    confidence is insufficient and the per-token gate is needed.)"""
    p = parse_ref("что значит BG 2.13")
    # Full booktext resolves to BG (token_set_ratio ignores the extras); only
    # "BG" resolves per-token, "что"/"значит" do not → alien → defer.
    fakes = _fakes({"что значит BG": [("src_bg", 1.0)], "BG": [("src_bg", 1.0)]}, {("src_bg", "2.13")})
    assert await decide(p, **fakes) is None


@pytest.mark.asyncio
async def test_decide_explicit_question_mark_defers() -> None:
    """A "?" anywhere is a language-neutral "answer me" hint → defer, even when
    the booktext would otherwise look bare."""
    p = parse_ref("BG 2.13?")
    fakes = _fakes({"BG": [("src_bg", 1.0)]}, {("src_bg", "2.13")})
    assert p.has_question is True
    assert await decide(p, **fakes) is None


@pytest.mark.asyncio
async def test_decide_verbose_query_defers() -> None:
    """«сделай pdf лекции по БГ 4.18» — the verse resolves and exists, but the
    number is buried in a bunch of surrounding words, so this is not a bare
    verse lookup. Defer to the LLM router (which reads the intent in any
    language → create_action → gathers lectures → PDF card) instead of
    short-circuiting to show_verse and stranding the request. Language-neutral:
    no verb list — "зроби pdf …" / "make a pdf of …" defer the same way."""
    # Only the abbreviation "БГ" names a book per-token; "сделай"/"pdf"/"лекции"/
    # "по" do not → alien → defer (the full booktext still fuzzy-resolves to BG).
    fakes = _fakes(
        {"сделай pdf лекции по БГ": [("src_bg", 1.0)], "БГ": [("src_bg", 1.0)]},
        {("src_bg", "4.18")},
    )
    assert await decide(parse_ref("сделай pdf лекции по БГ 4.18"), **fakes) is None
    # Even a non-action verbose phrasing ("lectures on BG 4.18") defers — it's
    # find_track, not show_verse, and the router decides that.
    fakes2 = _fakes({"лекции по БГ": [("src_bg", 1.0)], "БГ": [("src_bg", 1.0)]}, {("src_bg", "4.18")})
    assert await decide(parse_ref("лекции по БГ 4.18"), **fakes2) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query, booktext, book_token",
    [
        ("erkläre BG 2.13", "erkläre BG", "BG"),            # German imperative, no "?"
        ("explícame el BG 2.13", "explícame el BG", "BG"),  # Spanish imperative, no "?"
        ("गीता २.१३ का अर्थ", "गीता का अर्थ", "गीता"),         # Hindi "meaning of Gita 2.13", no "?"
    ],
)
async def test_decide_nonruen_explain_request_defers(query, booktext, book_token) -> None:
    """The reported bug: a verbose explain-request in a language we do NOT
    enumerate, WITHOUT a "?", used to short-circuit to a bare verse card because
    the old gate only listed ru/en interrogatives. The structural per-token gate
    now defers it to the LLM router in ANY language — no keyword list. The
    book token resolves; the foreign verb/words ("erkläre", "el", "का", "अर्थ")
    name no book → alien → defer."""
    # Full booktext fuzzy-resolves to BG; the book token resolves per-token too,
    # but the surrounding non-book words are absent from the map (→ no hit).
    fakes = _fakes(
        {booktext: [("src_bg", 1.0)], book_token: [("src_bg", 1.0)]},
        {("src_bg", "2.13")},
    )
    assert await decide(parse_ref(query), **fakes) is None


@pytest.mark.asyncio
async def test_decide_unresolved_book_defers() -> None:
    p = parse_ref("Гита 2.13")
    fakes = _fakes({}, {("src_bg", "2.13")})  # resolve_book returns nothing
    assert await decide(p, **fakes) is None


@pytest.mark.asyncio
async def test_decide_multiword_book_name_stays_bare() -> None:
    """A genuine multi-token book name ("Шримад Бхагаватам") must NOT be mistaken
    for surrounding text — BOTH tokens resolve to the book per-token, so it stays
    a bare reference (regression guard for the per-token gate)."""
    fakes = _fakes(
        {
            "Шримад Бхагаватам": [("src_sb", 0.95)],
            "Шримад": [("src_sb", 0.9)],      # each token names the book…
            "Бхагаватам": [("src_sb", 0.9)],  # …so neither is alien
        },
        {("src_sb", "1.2.6")},
    )
    assert await decide(parse_ref("Шримад Бхагаватам 1.2.6"), **fakes) == ("src_sb", "1.2.6")


@pytest.mark.asyncio
async def test_decide_ambiguous_family_defers() -> None:
    """Bare 'CC' family resolving to two lila that BOTH have the verse → defer.
    Single-token booktext ("ЧЧ") is bare; deferral is on the ambiguous hit."""
    p = parse_ref("ЧЧ 17.80")
    fakes = _fakes(
        {"ЧЧ": [("src_ccm", 0.75), ("src_cca", 0.75)]},
        {("src_ccm", "17.80"), ("src_cca", "17.80")},
    )
    assert await decide(p, **fakes) is None


@pytest.mark.asyncio
async def test_decide_nonexistent_verse_defers() -> None:
    p = parse_ref("ШБ 99.99.99")
    fakes = _fakes({"ШБ": [("src_sb", 1.0)]}, set())
    assert await decide(p, **fakes) is None
