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
    chunk_repo: Any = None
    user_id: str = ""


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


async def test_the_admission_is_not_stranded_under_the_paragraph_it_explains() -> None:
    """The planner paints the intro early, seconds before the synthesizer runs —
    so under a filter it would land ABOVE the admission that explains it. That is
    what production did on the first try: «...ответ основан на священных
    писаниях» arrived as the second paragraph. Under a filter the intro goes back
    to the synthesizer, which renders it after the note."""
    from dataclasses import field as dc_field

    from lectorium_chat.agent.graph.nodes import synthesis_planner as planner_mod
    from lectorium_chat.research.models import Outline, Thesis

    painted: list[str] = []

    class _LLM:
        async def structured_output(self, *_a, **_k):
            return Outline(
                intro="Вступление.",
                theses=[
                    Thesis(thesis="t1", supporting_notes=[1]),
                    Thesis(thesis="t2", supporting_notes=[1]),
                ],
            )

        async def text_completion(self, *_a, **_k):
            return ""

    @dataclass
    class _Runtime:
        context: Any = None

    for constrained, expect_early_paint in ((True, False), (False, True)):
        painted.clear()
        ctx = _Ctx(llm=_LLM(), author_scope=_scope([], constrained=constrained))
        # `catalog_repo` / `chunk_repo` / `aliases` are unused by this path.
        for extra in ("langfuse_trace_id", "embedder", "chunk_repo",
                      "catalog_repo", "aliases", "reranker", "lang_name"):
            setattr(ctx, extra, None if extra != "lang_name" else "")
        import lectorium_chat.agent.graph.nodes.synthesis_planner as sp

        orig = sp.get_stream_writer
        sp.get_stream_writer = lambda: (
            lambda ev: painted.append((ev.get("data") or {}).get("text", ""))
        )
        try:
            out = await planner_mod.synthesis_planner_node(
                {
                    "user_query": "q", "lang": "ru",
                    "tool_results": [
                        {"type": "verse", "text": "x", "score": 0.8, "meta": {}},
                    ],
                },
                _Runtime(context=ctx),
            )
        finally:
            sp.get_stream_writer = orig

        early = any("Вступление" in t for t in painted)
        assert early is expect_early_paint, (
            f"constrained={constrained}: early intro paint should be "
            f"{expect_early_paint}"
        )
        # And when it is held back, the synthesizer is the one given the intro.
        if not expect_early_paint:
            assert out["outline"].intro


# ── their own untagged uploads ────────────────────────────────────────────


class _Private:
    def __init__(self, untagged: int) -> None:
        self._untagged = untagged

    async def unattributed_owned_count(self, _user_id):
        return self._untagged


async def test_it_mentions_their_own_untagged_recordings() -> None:
    """Those uploads fall out of a filtered answer and nothing on screen says
    why. Naming the count turns "where is my lecture" into something actionable:
    tag the speaker."""
    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope([]))
    ctx.chunk_repo = _Private(3)
    ctx.user_id = "u-1"
    assert await author_gap_note(ctx, [_VERSE])
    assert "3 recording(s)" in llm.situations[0]


async def test_no_such_clause_when_every_upload_is_tagged() -> None:
    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope([]))
    ctx.chunk_repo = _Private(0)
    ctx.user_id = "u-1"
    await author_gap_note(ctx, [_VERSE])
    assert "no speaker recorded" not in llm.situations[0]


async def test_an_anonymous_turn_counts_nothing() -> None:
    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope([]))
    ctx.chunk_repo = _Private(5)
    ctx.user_id = ""
    await author_gap_note(ctx, [_VERSE])
    assert "recording(s)" not in llm.situations[0]


async def test_a_failed_count_is_simply_left_out() -> None:
    class _Broken:
        async def unattributed_owned_count(self, _user_id):
            raise RuntimeError("relation missing")

    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope([]))
    ctx.chunk_repo = _Broken()
    ctx.user_id = "u-1"
    # The disclaimer still gets written; only the extra clause is dropped.
    assert await author_gap_note(ctx, [_VERSE])
    assert "recording(s)" not in llm.situations[0]


# ── their recordings exist, in another language ────────────────────────────


class _Langs:
    def __init__(self, langs: list[str], untagged: int = 0) -> None:
        self._langs = langs
        self._untagged = untagged

    async def owned_langs_for_authors(self, _user_id, _ids, _raws):
        return list(self._langs)

    async def unattributed_owned_count(self, _user_id):
        return self._untagged


async def test_it_says_which_language_their_recordings_are_in() -> None:
    """The production case: three lectures by the asked-for teacher, all English,
    a Russian question — «не найдено» is the wrong answer, «они на английском» is
    the right one."""
    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope([]))
    ctx.chunk_repo = _Langs(["en"])
    ctx.user_id = "u-1"
    assert await author_gap_note(ctx, [_VERSE])
    asked = llm.situations[0]
    # A distinctive phrase, not the bare code: "en" hides inside "sentence".
    assert "not the language of this answer" in asked
    assert "are in en," in asked


async def test_no_language_clause_when_they_are_in_the_answers_language() -> None:
    # Then the miss is about the topic, and blaming the language would mislead.
    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope([]))
    ctx.chunk_repo = _Langs(["ru"])
    ctx.user_id = "u-1"
    await author_gap_note(ctx, [_VERSE])
    assert "not the language of this answer" not in llm.situations[0]


async def test_a_failed_language_lookup_is_left_out() -> None:
    class _Broken:
        async def owned_langs_for_authors(self, *_a):
            raise RuntimeError("relation missing")

        async def unattributed_owned_count(self, _u):
            return 0

    llm = _LLM()
    ctx = _Ctx(llm=llm, author_scope=_scope([]))
    ctx.chunk_repo = _Broken()
    ctx.user_id = "u-1"
    assert await author_gap_note(ctx, [_VERSE])
    assert "not the language of this answer" not in llm.situations[0]


async def test_no_apology_when_their_own_recordings_did_contribute() -> None:
    """Production printed «записи Рохини Суты Прабху на этом языке отсутствуют»
    above four translated citations OF HIS. The pool the synthesizer is handed
    showed verse/commentary only — their fragments reach the answer by another
    route — so the private lane's own count is what settles it."""
    llm = _LLM()
    scope = _scope([])
    scope.note_private_hits(4)
    ctx = _Ctx(llm=llm, author_scope=scope)
    ctx.chunk_repo = _Langs(["en"])
    ctx.user_id = "u-1"
    assert await author_gap_note(ctx, [_VERSE]) == ""
    assert llm.situations == []


async def test_the_private_lane_reports_its_yield() -> None:
    """The wire: `corpus_fanout` must tell the scope what it found, or the note is
    back to guessing from a pool that does not show it."""
    import inspect

    from lectorium_chat.research import corpus_fanout

    lane = inspect.getsource(corpus_fanout).split("async def _user_lecture")[1]
    lane = lane.split("async def ")[0]
    assert "note_private_hits(" in lane
