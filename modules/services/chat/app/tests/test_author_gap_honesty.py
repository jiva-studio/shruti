"""When the chosen lecturers contributed nothing, the answer says so.

Three things have to hold together, and each one is a different way of lying by
omission:

1. an answer built only from scripture under a lecturer filter admits the gap —
   otherwise it is indistinguishable from an answer that merely preferred
   scripture, and the person cannot tell their filter did anything;
2. the two situations are told apart: the corpus holds NO lectures by them, or it
   holds some and none fit this question;
3. the memory-pass fallback stays OFF under a filter. It answers from the MODEL's
   knowledge, which is the opposite of what someone narrowing to a teacher asked
   for — ungrounded prose under a filter they set, with nothing marking it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes._author_note import author_gap_note
from lectorium_chat.application.author_scope import AuthorScope
from lectorium_chat.domain.author_selection import AuthorSelection
from lectorium_chat.domain.conversation_attributes import LECTURE_AUTHORS, Attribute


_LECTURE = {"type": "lecture", "text": "x", "score": 0.8, "meta": {}}
_VERSE = {"type": "verse", "text": "y", "score": 0.8, "meta": {}}


class _Catalog:
    def __init__(self, tracks: list[str] | None) -> None:
        self._tracks = tracks

    async def filter_track_ids(self, **_kw):
        return self._tracks


class _LLM:
    """Records the situation it was asked to phrase, answers in fake Russian."""

    def __init__(self) -> None:
        self.situations: list[str] = []

    async def structured_output(self, messages, schema, **_kw):
        self.situations.append(messages[-1]["content"])
        return schema(line="У выбранного лектора об этом ничего нет.", chips=[])


@dataclass
class _Ctx:
    llm: Any = None
    request_id: str = "req"
    lang_code: str = "ru"
    kv_cache: Any = None
    author_scope: Any = None


def _scope(tracks: list[str] | None, *, constrained: bool = True) -> AuthorScope:
    scope = AuthorScope(catalog_repo=_Catalog(tracks), request_id="req")
    scope.apply(
        AuthorSelection.from_attributes({
            LECTURE_AUTHORS: Attribute(
                value=["author_x"], label="Шрила Бхактивинода Тхакур",
                explicit=True,
            ),
        })
        if constrained else AuthorSelection.unconstrained()
    )
    return scope


async def test_it_admits_the_corpus_has_none_of_their_lectures() -> None:
    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope([]))
    line = await author_gap_note(ctx, [_VERSE])
    assert line
    asked = llm.situations[0]
    # The teacher is named — a nameless apology is not an explanation.
    assert "Шрила Бхактивинода Тхакур" in asked
    assert "no lectures by them at all" in asked


async def test_it_separates_no_lectures_from_no_match() -> None:
    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope(["t1", "t2"]))
    await author_gap_note(ctx, [_VERSE])
    asked = llm.situations[0]
    assert "none of them covers this question" in asked
    assert "no lectures by them at all" not in asked


async def test_no_note_when_one_of_their_lectures_did_reach_the_answer() -> None:
    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope(["t1"]))
    assert await author_gap_note(ctx, [_VERSE, _LECTURE]) == ""
    assert llm.situations == []


async def test_no_note_when_nothing_was_narrowed() -> None:
    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope(None, constrained=False))
    assert await author_gap_note(ctx, [_VERSE]) == ""
    assert llm.situations == []


async def test_a_failed_lookup_claims_nothing_about_the_corpus() -> None:
    # Resolution failed open (None), so we do not know whether they have
    # lectures — and an answer that guesses out loud is worse than a silent one.
    llm = _LLM()

    class _Broken:
        async def filter_track_ids(self, **_kw):
            raise RuntimeError("catalog down")

    scope = AuthorScope(catalog_repo=_Broken(), request_id="req")
    scope.apply(AuthorSelection.from_attributes({
        LECTURE_AUTHORS: Attribute(value=["author_x"], label="X", explicit=True),
    }))
    assert await author_gap_note(_Ctx(llm=llm, author_scope=scope), [_VERSE]) == ""


async def test_a_turn_with_no_scope_at_all_is_silent() -> None:
    assert await author_gap_note(_Ctx(llm=_LLM()), [_VERSE]) == ""


# ── the memory pass must not run under a filter ───────────────────────────


@pytest.mark.parametrize("constrained,expected", [(True, False), (False, True)])
async def test_the_memory_pass_is_off_while_a_filter_is_on(
    constrained: bool, expected: bool,
) -> None:
    from lectorium_chat.agent.graph.nodes.synthesis_planner import _fallback_enabled

    state = {"config": {"enable_corpus_fallback": True}}
    ctx = _Ctx(author_scope=_scope([], constrained=constrained))
    assert _fallback_enabled(state, ctx) is expected


async def test_without_a_scope_the_setting_still_decides() -> None:
    from lectorium_chat.agent.graph.nodes.synthesis_planner import _fallback_enabled

    assert _fallback_enabled({"config": {"enable_corpus_fallback": True}}) is True
    assert _fallback_enabled({"config": {"enable_corpus_fallback": False}}) is False


async def test_the_planner_does_not_flag_the_fallback_under_a_filter() -> None:
    """End of the wire, not just the helper: an empty retrieval under a filter
    must reach the synthesizer's refusal, never the memory pass."""
    from dataclasses import field as dc_field

    from lectorium_chat.agent.graph.nodes.synthesis_planner import (
        synthesis_planner_node,
    )

    @dataclass
    class _Runtime:
        context: _Ctx = dc_field(default_factory=_Ctx)

    state = {
        "user_query": "как развить смирение", "lang": "ru", "tool_results": [],
        "config": {"enable_corpus_fallback": True},
    }
    out = await synthesis_planner_node(
        state, _Runtime(context=_Ctx(author_scope=_scope([]))),
    )
    assert out == {"outline": None, "corpus_insufficient": False}
