"""Unit tests for research.outline_builder."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel

from shruti_chat.research.models import ConclusionResponse, Outline, Thesis
from shruti_chat.research.outline_builder import build_outline


class FakeLLM:
    """Records calls; returns a scripted Outline (or raises).

    Supports schema-routed scripts via `by_schema` for testing the
    conclusion-writer fallback which uses a SECOND structured_output
    call with a different schema.
    """

    def __init__(self, script: Any = None, by_schema: dict | None = None) -> None:
        self.script = script
        self.by_schema = by_schema or {}
        self.calls: list[tuple[list[dict], type[BaseModel], str | None]] = []

    async def structured_output(
        self, messages: list[dict], schema: type[BaseModel], *,
        model: str | None = None, **_extra,
    ):
        self.calls.append((messages, schema, model))
        if schema.__name__ in self.by_schema:
            value = self.by_schema[schema.__name__]
            if callable(value):
                return value(messages, schema, model)
            return value
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
    llm = FakeLLM(by_schema={
        "Outline": _outline_3_theses(conclusion="planner-provided conclusion."),
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    # Only ONE structured_output call (Outline). No ConclusionResponse call.
    schemas_called = [c[1].__name__ for c in llm.calls]
    assert schemas_called == ["Outline"]
    assert out.conclusion == "planner-provided conclusion."


@pytest.mark.asyncio
async def test_planner_skips_conclusion_under_3_theses_no_fallback() -> None:
    """Single/double-thesis outlines don't get a conclusion — they're
    held in the reader's mind without one."""
    llm = FakeLLM(by_schema={
        "Outline": Outline(theses=[
            Thesis(thesis="only one", supporting_notes=[1]),
            Thesis(thesis="only two", supporting_notes=[1]),
        ], conclusion=None),
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    schemas_called = [c[1].__name__ for c in llm.calls]
    assert schemas_called == ["Outline"]
    assert out.conclusion is None


@pytest.mark.asyncio
async def test_planner_skips_conclusion_on_3plus_theses_fallback_fires() -> None:
    """The headline case: planner left conclusion=None on a 3+ thesis
    outline → fallback synthesises one."""
    llm = FakeLLM(by_schema={
        "Outline": _outline_3_theses(conclusion=None),
        "ConclusionResponse": ConclusionResponse(
            conclusion="Таким образом, синтез трёх тезисов сходится в одной точке.",
        ),
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    schemas_called = [c[1].__name__ for c in llm.calls]
    assert "ConclusionResponse" in schemas_called
    assert out.conclusion == "Таким образом, синтез трёх тезисов сходится в одной точке."


@pytest.mark.asyncio
async def test_planner_returns_empty_conclusion_string_triggers_fallback() -> None:
    """Empty-string conclusion is treated the same as None — the planner
    didn't actually write one, just put an empty value."""
    llm = FakeLLM(by_schema={
        "Outline": _outline_3_theses(conclusion="   "),
        "ConclusionResponse": ConclusionResponse(conclusion="proper conclusion"),
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    schemas_called = [c[1].__name__ for c in llm.calls]
    assert "ConclusionResponse" in schemas_called
    assert out.conclusion == "proper conclusion"


@pytest.mark.asyncio
async def test_fallback_failure_returns_outline_with_null_conclusion() -> None:
    """If the conclusion-writer LLM call raises, outline keeps conclusion
    = None — synthesizer ends on the last thesis as before."""
    def conclusion_boom(*a, **kw):
        raise RuntimeError("openrouter 503")
    llm = FakeLLM(by_schema={
        "Outline": _outline_3_theses(conclusion=None),
        "ConclusionResponse": conclusion_boom,
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
    llm = FakeLLM(by_schema={
        "Outline": _outline_3_theses(conclusion=None),
        "ConclusionResponse": ConclusionResponse(conclusion=""),
    })
    out = await build_outline("q", "ru", [_note(0)], llm=llm)
    assert out.conclusion is None


@pytest.mark.asyncio
async def test_fallback_uses_conclusion_model_override() -> None:
    """`conclusion_model` parameter routes to the conclusion-writer call
    when Langfuse prompt-config doesn't override."""
    llm = FakeLLM(by_schema={
        "Outline": _outline_3_theses(conclusion=None),
        "ConclusionResponse": ConclusionResponse(conclusion="x"),
    })
    await build_outline(
        "q", "ru", [_note(0)], llm=llm,
        conclusion_model="openrouter/google/gemini-3.1-flash-lite",
    )
    # Find the ConclusionResponse call and verify the model override.
    cr_call = next(c for c in llm.calls if c[1].__name__ == "ConclusionResponse")
    assert cr_call[2] == "openrouter/google/gemini-3.1-flash-lite"
