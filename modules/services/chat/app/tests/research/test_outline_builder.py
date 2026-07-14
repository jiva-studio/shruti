"""Unit tests for research.outline_builder."""

from __future__ import annotations

from typing import Any

import pytest

from lectorium_chat.research.models import Outline, Thesis
from lectorium_chat.research.outline_builder import build_outline, synthesize_intro


class FakeLLM:
    """Records calls; returns a scripted value (or raises).

    `by_key` routes a scripted response per call, keyed by the schema name
    for `structured_output` (the planner's `Outline`) or by `run_name` for
    `text_completion` (the `conclusion_writer` / `intro_writer` prose passes,
    which return a plain string).
    """

    def __init__(self, script: Any = None, by_key: dict | None = None) -> None:
        self.script = script
        self.by_key = by_key or {}
        # (messages, key, model) — key = schema name or run_name.
        self.calls: list[tuple[list[dict], str, str | None]] = []

    async def structured_output(
        self, messages: list[dict], schema, *, model: str | None = None, **_extra,
    ):
        return self._dispatch(messages, schema.__name__, model, schema=schema)

    async def text_completion(
        self, messages: list[dict], *, model: str | None = None,
        run_name: str | None = None,
    ) -> str:
        return self._dispatch(messages, run_name or "", model, schema=None)

    def _dispatch(self, messages, key, model, *, schema):
        self.calls.append((messages, key, model))
        if key in self.by_key:
            value = self.by_key[key]
            return value(messages, model) if callable(value) else value
        if schema is None:
            # text_completion (prose writers): run a callable script so a
            # raising stub still fires, but never hand back a scripted
            # Outline as prose — an unscripted writer just returns "".
            if callable(self.script):
                return self.script(messages, None, model)
            return ""
        if callable(self.script):
            return self.script(messages, schema, model)
        return self.script


def _note(idx: int, *, text: str = "x", score: float = 0.7, **meta) -> dict:
    return {
        "type": meta.pop("type", "lecture"),
        "label": meta.pop("label", ""),
        "text": text,
        "score": score,
        "meta": meta,
    }


@pytest.mark.asyncio
async def test_curator_note_anchors_the_planner(monkeypatch) -> None:
    """A memory_note rides into the planner's user message as an AUTHORITATIVE
    curator-note block (Phase 4 — thesis-anchoring)."""
    llm = FakeLLM(Outline(theses=[
        Thesis(thesis="t", supporting_notes=[1]),
    ]))
    await build_outline(
        "структура Бхагавад-гиты", "ru",
        [_note(1, text="atma", label="БГ 6.47")],
        llm=llm,
        memory_notes=["Шаг 1 — бхакти выше всех путей (БГ 6.47)."],
    )
    user_msg = llm.calls[0][0][1]["content"]
    assert "Curator note" in user_msg
    assert "ANCHOR" in user_msg
    assert "Шаг 1 — бхакти выше всех" in user_msg


@pytest.mark.asyncio
async def test_no_curator_block_without_memory_note() -> None:
    llm = FakeLLM(Outline(theses=[Thesis(thesis="t", supporting_notes=[1])]))
    await build_outline("q", "ru", [_note(1)], llm=llm)
    assert "Curator note" not in llm.calls[0][0][1]["content"]


@pytest.mark.asyncio
async def test_returns_outline_for_good_notes() -> None:
    llm = FakeLLM(Outline(theses=[
        Thesis(thesis="первое", supporting_notes=[1, 2], sub_query_types=["definition"]),
        Thesis(thesis="второе", supporting_notes=[3], sub_query_types=["scripture_ref"]),
    ]))
    notes = [_note(i, sub_query_id=0) for i in range(3)]
    outline = await build_outline("вопрос", "ru", notes, llm=llm)
    assert outline is not None
    assert len(outline.theses) == 2
    assert outline.theses[0].supporting_notes == [1, 2]
    assert outline.theses[1].supporting_notes == [3]


@pytest.mark.asyncio
async def test_llm_failure_returns_none() -> None:
    def boom(*a, **kw):
        raise RuntimeError("openrouter 503")
    llm = FakeLLM(boom)
    notes = [_note(0)]
    outline = await build_outline("вопрос", "ru", notes, llm=llm)
    assert outline is None


@pytest.mark.asyncio
async def test_empty_notes_returns_empty_outline_not_none() -> None:
    """No notes → no LLM call → deliberate empty outline (refusal path).
    Distinct from `None` (LLM failure, fall back to free-form)."""
    llm = FakeLLM(Outline(theses=[]))
    outline = await build_outline("вопрос", "ru", [], llm=llm)
    assert outline is not None
    assert outline.theses == []
    assert llm.calls == []  # LLM never called


@pytest.mark.asyncio
async def test_empty_theses_passes_through_as_refusal_signal() -> None:
    llm = FakeLLM(Outline(theses=[], skipped_reason="all off-topic"))
    notes = [_note(i) for i in range(3)]
    outline = await build_outline("вопрос", "ru", notes, llm=llm)
    assert outline is not None
    assert outline.theses == []
    assert outline.skipped_reason == "all off-topic"


@pytest.mark.asyncio
async def test_broken_refs_filtered() -> None:
    """LLM emits supporting_notes with indices outside 1..n_notes —
    filtered out, valid indices preserved."""
    llm = FakeLLM(Outline(theses=[
        # n_notes=3, so indices 1..3 valid; 99 invalid
        Thesis(thesis="ok", supporting_notes=[1, 99, 2]),
        # all invalid → entire thesis dropped
        Thesis(thesis="dropped", supporting_notes=[7, 8, 9]),
    ]))
    notes = [_note(i) for i in range(3)]
    outline = await build_outline("вопрос", "ru", notes, llm=llm)
    assert outline is not None
    assert len(outline.theses) == 1
    assert outline.theses[0].thesis == "ok"
    assert outline.theses[0].supporting_notes == [1, 2]


@pytest.mark.asyncio
async def test_notes_without_sub_query_id_render_as_general() -> None:
    """Legacy notes from persisted history don't have meta.sub_query_id.
    The renderer should omit the sub_query_type header (planner prompt
    explicitly says: absent → treat as general)."""
    llm = FakeLLM(Outline(theses=[
        Thesis(thesis="t", supporting_notes=[1]),
    ]))
    # No sub_query_id, no sub_query_type in meta
    notes = [_note(0, text="legacy chunk")]
    outline = await build_outline("вопрос", "ru", notes, llm=llm)
    assert outline is not None
    user_msg = next(m["content"] for m in llm.calls[0][0] if m["role"] == "user")
    assert "sub_query_type=" not in user_msg
    assert "sub_query_id=" not in user_msg


@pytest.mark.asyncio
async def test_notes_with_sub_query_id_render_tagged() -> None:
    llm = FakeLLM(Outline(theses=[Thesis(thesis="t", supporting_notes=[1])]))
    notes = [_note(0, sub_query_id=2, sub_query_type="contrast")]
    outline = await build_outline("вопрос", "ru", notes, llm=llm)
    user_msg = next(m["content"] for m in llm.calls[0][0] if m["role"] == "user")
    assert "sub_query_type=contrast" in user_msg


@pytest.mark.asyncio
async def test_passes_model_override() -> None:
    llm = FakeLLM(Outline(theses=[Thesis(thesis="t", supporting_notes=[1])]))
    notes = [_note(0)]
    await build_outline(
        "q", "ru", notes, llm=llm,
        model="openrouter/google/gemini-2.5-flash",
    )
    _, _, model = llm.calls[0]
    assert model == "openrouter/google/gemini-2.5-flash"


@pytest.mark.asyncio
async def test_note_text_trimmed_to_600_chars() -> None:
    llm = FakeLLM(Outline(theses=[Thesis(thesis="t", supporting_notes=[1])]))
    long_text = "x" * 2000
    notes = [_note(0, text=long_text)]
    await build_outline("q", "ru", notes, llm=llm)
    user_msg = next(m["content"] for m in llm.calls[0][0] if m["role"] == "user")
    # We trim around 600 chars; should include the ellipsis sentinel and
    # should NOT contain the full 2000-char block.
    assert "…" in user_msg
    assert "x" * 1000 not in user_msg


# ── Conclusion fallback ────────────────────────────────────────────


def _outline_3_theses(conclusion: str | None = None) -> Outline:
    return Outline(theses=[
        Thesis(thesis="first thesis statement", supporting_notes=[1]),
        Thesis(thesis="second thesis statement", supporting_notes=[1]),
        Thesis(thesis="third thesis statement", supporting_notes=[1]),
    ], conclusion=conclusion)


@pytest.mark.asyncio
async def test_planner_returns_conclusion_no_fallback_call() -> None:
    """Planner did its job — server-side fallback must NOT fire."""
    llm = FakeLLM(by_key={
        "Outline": _outline_3_theses(conclusion="planner-provided conclusion."),
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    # Planner gave a conclusion → no conclusion-writer fallback call. The
    # intro rewrite is NOT done here (it's a separate pass the node runs
    # concurrently with Stage 1), so build_outline makes ONE call.
    keys_called = [c[1] for c in llm.calls]
    assert keys_called == ["Outline"]
    assert out.conclusion == "planner-provided conclusion."


@pytest.mark.asyncio
async def test_planner_skips_conclusion_single_thesis_no_fallback() -> None:
    """A single-thesis outline gets no conclusion — the lone paragraph
    speaks for itself, so the fallback must NOT fire (threshold is 2)."""
    llm = FakeLLM(by_key={
        "Outline": Outline(theses=[
            Thesis(thesis="only one", supporting_notes=[1]),
        ], conclusion=None),
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    # 1 thesis: conclusion fallback must NOT fire (needs 2+). Intro is not
    # written here either → exactly one LLM call (the planner).
    keys_called = [c[1] for c in llm.calls]
    assert keys_called == ["Outline"]
    assert out.conclusion is None


@pytest.mark.asyncio
async def test_planner_skips_conclusion_two_theses_fallback_fires() -> None:
    """A two-thesis outline with no conclusion now triggers the fallback —
    multi-thesis answers carry both bookends, so the threshold is 2, not 3."""
    llm = FakeLLM(by_key={
        "Outline": Outline(theses=[
            Thesis(thesis="first", supporting_notes=[1]),
            Thesis(thesis="second", supporting_notes=[1]),
        ], conclusion=None),
        "conclusion_writer": "two-thesis conclusion",
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    keys_called = [c[1] for c in llm.calls]
    assert keys_called == ["Outline", "conclusion_writer"]
    assert out.conclusion == "two-thesis conclusion"


@pytest.mark.asyncio
async def test_synthesize_intro_returns_claim_string() -> None:
    """The dedicated pass returns the rewritten intro built from the theses.

    (The synthesis_planner node runs this CONCURRENTLY with Stage 1 and
    applies the result to the outline — build_outline no longer does it.)"""
    outline = Outline(intro="мы рассмотрим A, B", theses=[
        Thesis(thesis="claim one", supporting_notes=[1]),
        Thesis(thesis="claim two", supporting_notes=[1]),
    ])
    llm = FakeLLM(by_key={"intro_writer": "claim-bearing intro"})
    result = await synthesize_intro(outline, "ru", llm=llm)
    assert result == "claim-bearing intro"
    assert [c[1] for c in llm.calls] == ["intro_writer"]


@pytest.mark.asyncio
async def test_synthesize_intro_empty_returns_none() -> None:
    """Empty/blank intro → None, so the caller keeps the planner's intro."""
    outline = Outline(theses=[
        Thesis(thesis="a", supporting_notes=[1]),
        Thesis(thesis="b", supporting_notes=[1]),
    ])
    llm = FakeLLM(by_key={"intro_writer": "   "})
    result = await synthesize_intro(outline, "ru", llm=llm)
    assert result is None


@pytest.mark.asyncio
async def test_synthesize_intro_failure_returns_none() -> None:
    """LLM failure → None (best-effort), never raises into the turn."""
    def boom(*a, **kw):
        raise RuntimeError("openrouter 503")
    outline = Outline(theses=[
        Thesis(thesis="a", supporting_notes=[1]),
        Thesis(thesis="b", supporting_notes=[1]),
    ])
    result = await synthesize_intro(outline, "ru", llm=FakeLLM(boom))
    assert result is None


@pytest.mark.asyncio
async def test_planner_skips_conclusion_on_3plus_theses_fallback_fires() -> None:
    """The headline case: planner left conclusion=None on a 3+ thesis
    outline → fallback synthesises one."""
    llm = FakeLLM(by_key={
        "Outline": _outline_3_theses(conclusion=None),
        "conclusion_writer": "Таким образом, синтез трёх тезисов сходится в одной точке.",
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    keys_called = [c[1] for c in llm.calls]
    assert "conclusion_writer" in keys_called
    assert out.conclusion == "Таким образом, синтез трёх тезисов сходится в одной точке."


@pytest.mark.asyncio
async def test_planner_returns_empty_conclusion_string_triggers_fallback() -> None:
    """Empty-string conclusion is treated the same as None — the planner
    didn't actually write one, just put an empty value."""
    llm = FakeLLM(by_key={
        "Outline": _outline_3_theses(conclusion="   "),
        "conclusion_writer": "proper conclusion",
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    keys_called = [c[1] for c in llm.calls]
    assert "conclusion_writer" in keys_called
    assert out.conclusion == "proper conclusion"


@pytest.mark.asyncio
async def test_fallback_failure_returns_outline_with_null_conclusion() -> None:
    """If the conclusion-writer LLM call raises, outline keeps conclusion
    = None — synthesizer ends on the last thesis as before."""
    def conclusion_boom(*a, **kw):
        raise RuntimeError("openrouter 503")
    llm = FakeLLM(by_key={
        "Outline": _outline_3_theses(conclusion=None),
        "conclusion_writer": conclusion_boom,
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    assert out.conclusion is None
    # Theses preserved.
    assert len(out.theses) == 3


@pytest.mark.asyncio
async def test_fallback_returns_empty_string_keeps_null_conclusion() -> None:
    """The conclusion writer's prompt allows it to signal `no good
    conclusion fits` by returning empty string — we honour that and
    leave the outline ending on the last thesis."""
    llm = FakeLLM(by_key={
        "Outline": _outline_3_theses(conclusion=None),
        "conclusion_writer": "",
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    assert out.conclusion is None


@pytest.mark.asyncio
async def test_fallback_uses_conclusion_model_override() -> None:
    """`conclusion_model` parameter routes to the conclusion-writer call
    when Langfuse prompt-config doesn't override."""
    llm = FakeLLM(by_key={
        "Outline": _outline_3_theses(conclusion=None),
        "conclusion_writer": "x",
    })
    await build_outline(
        "q", "ru", [_note(0)], llm=llm,
        conclusion_model="openrouter/google/gemini-3.1-flash-lite",
    )
    # Find the conclusion-writer call and verify the model override.
    cr_call = next(c for c in llm.calls if c[1] == "conclusion_writer")
    assert cr_call[2] == "openrouter/google/gemini-3.1-flash-lite"
