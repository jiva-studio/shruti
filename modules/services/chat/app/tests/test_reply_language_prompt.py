"""The reply-language contract, pinned across the prompt sections that decide it.

The answer language is decided by the model, not by code: the locale the client
sends is only the fallback for when the user's message gives nothing to go on.
That rule has to hold in EVERY hop that composes user-visible prose, or the hops
disagree — which is exactly what shipped on production, where a Hindi answer body
carried an English summary paragraph because the planner obeyed the locale while
the synthesizer obeyed the user's request.

These tests assert the wording, which is all a prompt can be asserted on without
a live model. Their value is preventing a silent revert to "only the `Language:`
field decides", the clause that caused the defect.
"""

from __future__ import annotations

import pytest

from lectorium_chat.agent.prompts import build_prompt

# Every section that composes prose the user reads.
_PROSE_SECTIONS = ("language", "synthesis_planner", "intro_writer", "conclusion_writer")


def _section(name: str) -> str:
    return build_prompt((name,), lang="ru", lang_name="Русский")


@pytest.mark.parametrize("section", _PROSE_SECTIONS)
def test_no_section_makes_the_locale_the_sole_authority(section: str) -> None:
    # "Only that field decides" is the clause that produced the mixed-language
    # answers: it forbids honouring an explicit request from the user.
    text = _section(section).lower()
    for forbidden in (
        "only that field decides",
        "only the `language:` field decides",
        "reply strictly in",
    ):
        assert forbidden not in text, f"{section} reasserts the locale as sole authority"


def test_language_section_states_the_precedence() -> None:
    text = _section("language").lower()
    # 1. an explicit request wins and persists
    assert "asked to be answered in a particular language" in text
    assert "rest of the conversation" in text
    # 2. otherwise the language of the user's message
    assert "language of the user's own message" in text
    # 3. the locale is the fallback, and is still interpolated
    assert "{{lang_name}}" not in text  # substituted, not left as a placeholder
    assert "русский" in text


def test_language_section_settles_the_script_for_multi_script_languages() -> None:
    # Serbian ships in two scripts, so naming the language is not enough: an
    # answer to «odgovaraj na srpskom» in Cyrillic is the wrong answer.
    text = _section("language").lower()
    assert "more than one script" in text
    assert "script the user is writing in" in text
    assert "sr-latn" in text and "sr-cyrl" in text


def test_language_section_separates_a_request_from_a_search_filter() -> None:
    # «есть лекции на английском?» asks about the CORPUS; it must not be read as
    # a request to switch the reply language.
    assert "not a request about the reply" in _section("language").lower()


def test_planner_names_the_mixed_language_defect() -> None:
    # The planner writes the intro that sat in the wrong language on prod, so its
    # prompt carries the rule explicitly rather than by implication.
    text = _section("synthesis_planner").lower()
    assert "asks to be answered in a particular language" in text
    assert "intro` in one language above a body in another" in text
    # The planner is shown the current question only — its rule must not depend on
    # an earlier turn it cannot see.
    assert "not the earlier conversation" in text


@pytest.mark.parametrize("section", ("intro_writer", "conclusion_writer"))
def test_downstream_writers_inherit_the_language_from_the_theses(section: str) -> None:
    # These hops never see the user's message — they can only follow the theses
    # the planner already composed in the right language.
    text = _section(section).lower()
    assert "language of the theses" in text
    assert "fall back to the `language:` field" in text
