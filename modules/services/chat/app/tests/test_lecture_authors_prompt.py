"""The one distinction the lecturer prompt exists to make.

«отвечай только по лекциям Прабхупады» chooses a lecturer for every following
answer. «есть лекции Прабхупады?» is a question ABOUT the corpus and must change
nothing — the router's own per-turn author argument already handles it. Losing
that line is the expensive failure: a sticky filter nobody asked for, silently
narrowing the rest of the conversation.

Wording is all a prompt can be asserted on without a live model. The value here
is preventing a quiet rewrite that drops the abstain rule.
"""

from __future__ import annotations

from shruti_chat.application.conversation_attributes import LectureAuthorsSpec


def _text() -> str:
    from shruti_chat.application.conversation_attributes import _bundled

    return _bundled(LectureAuthorsSpec.md)


def test_it_says_to_abstain_by_default() -> None:
    text = _text().lower()
    assert "leave both empty" in text


def test_it_keeps_a_question_about_the_corpus_from_setting_a_filter() -> None:
    text = _text()
    # The exact confusable pair, spelled out for the model.
    assert "есть лекции" in text
    assert "что прабхупада говорил" in text.lower()


def test_it_explains_that_the_choice_sticks() -> None:
    # Why abstaining matters: a reading is not undone by the next message.
    assert "sticks" in _text().lower()


def test_it_says_a_book_is_not_a_lecturer() -> None:
    # «только по Бхагавад-гите» is a source filter, and scripture is never
    # narrowed by who is speaking.
    text = _text().lower()
    assert "books" in text or "scripture" in text


def test_it_forbids_everyone_together_with_names() -> None:
    # `AuthorSelection` reads that pair as everyone, so a model that emits both
    # would silently drop the names — better it never emits them.
    assert "never set `everyone: true` together with `names`" in _text().lower()
