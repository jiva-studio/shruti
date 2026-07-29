"""LectureUrlClassifier: a pasted external lecture URL → add-to-library."""

from __future__ import annotations

import pytest

from shruti_chat.agent.classify.lecture_url import LectureUrlClassifier


class _Ctx:
    lang = "ru"
    catalog_repo = None
    library_db_path = None


@pytest.mark.parametrize(
    "query",
    [
        "https://youtu.be/jNQXAC9IVRw",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s",
        "https://youtube.com/shorts/abcDEF12345",
        "сохрани https://youtu.be/xyz",            # short add phrase
        "add https://cdn.example.org/talk.mp3",     # direct audio
    ],
)
async def test_bare_or_short_lecture_url_routes_to_add_to_library(query) -> None:
    d = await LectureUrlClassifier().classify(query, _Ctx())
    assert d is not None
    assert d.intent == "add-to-library"
    assert d.confidence == 1.0


@pytest.mark.parametrize(
    "query",
    [
        "что рассказывает про бхакти эта лекция https://youtu.be/xyz и почему",  # long question
        "какая книга самая важная в веданте",   # no url
        "https://example.com/some/article",       # non-lecture url
        "",
    ],
)
async def test_non_bare_or_non_lecture_falls_through(query) -> None:
    assert await LectureUrlClassifier().classify(query, _Ctx()) is None
