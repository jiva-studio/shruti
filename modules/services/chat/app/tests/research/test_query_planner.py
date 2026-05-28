"""Unit tests for research.query_planner."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel

from shruti_chat.research.models import QueryPlan, SubQuery
from shruti_chat.research.query_planner import plan_queries


class FakeLLM:
    """Records the messages and returns a scripted QueryPlan.
    Set `script` to a callable for richer behaviour (raise to simulate
    upstream failure)."""

    def __init__(self, script: Any) -> None:
        self.script = script
        self.calls: list[tuple[list[dict], type[BaseModel], str | None]] = []

    async def structured_output(self, messages: list[dict], schema: type[BaseModel], *, model: str | None = None, **_extra):
        self.calls.append((messages, schema, model))
        if callable(self.script):
            return self.script(messages, schema, model)
        return self.script


@pytest.mark.asyncio
async def test_simple_question_passthrough_single_sub_query() -> None:
    llm = FakeLLM(QueryPlan(sub_queries=[
        SubQuery(id=0, type="definition", text="что такое атма",
                 alt_phrasings=["what is atma"]),
    ]))
    plan = await plan_queries("что такое атма", "ru", {}, llm=llm)
    assert len(plan.sub_queries) == 1
    assert plan.sub_queries[0].type == "definition"
    assert plan.sub_queries[0].text == "что такое атма"
    assert plan.sub_queries[0].alt_phrasings == ["what is atma"]


@pytest.mark.asyncio
async def test_multi_intent_returns_multiple_typed_sub_queries() -> None:
    llm = FakeLLM(QueryPlan(sub_queries=[
        SubQuery(id=0, type="definition", text="что такое prarabdha karma"),
        SubQuery(id=1, type="contrast", text="как бхакти сжигает prarabdha"),
        SubQuery(id=2, type="scripture_ref", text="yat-pāda-paṅkaja…"),
    ]))
    plan = await plan_queries("карма и бхакти", "ru", {}, llm=llm)
    assert len(plan.sub_queries) == 3
    types = [sq.type for sq in plan.sub_queries]
    assert types == ["definition", "contrast", "scripture_ref"]


@pytest.mark.asyncio
async def test_ids_renumbered_positionally() -> None:
    """The LLM may emit non-sequential ids; the cleaner re-assigns 0..N."""
    llm = FakeLLM(QueryPlan(sub_queries=[
        SubQuery(id=5, type="definition", text="a"),
        SubQuery(id=99, type="contrast", text="b"),
    ]))
    plan = await plan_queries("q", "ru", {}, llm=llm)
    assert [sq.id for sq in plan.sub_queries] == [0, 1]


@pytest.mark.asyncio
async def test_capped_at_4_sub_queries() -> None:
    """`QueryPlan.sub_queries` is `max_length=4` at the schema level, so
    Pydantic rejects any LLM output with >4 entries during
    `structured_output`. The cap is therefore enforced before `_clean`
    ever sees it — we use `model_construct` to bypass validation and
    verify `_clean` doesn't somehow expand beyond the cap on its own."""
    over_cap = QueryPlan.model_construct(
        sub_queries=[
            SubQuery(id=i, type="general", text=f"q{i}") for i in range(7)
        ],
    )
    llm = FakeLLM(over_cap)
    plan = await plan_queries("q", "ru", {}, llm=llm)
    assert len(plan.sub_queries) == 4


@pytest.mark.asyncio
async def test_strips_empty_text_sub_queries() -> None:
    llm = FakeLLM(QueryPlan(sub_queries=[
        SubQuery(id=0, type="definition", text="good"),
        SubQuery(id=1, type="general", text="   "),
        SubQuery(id=2, type="general", text=""),
        SubQuery(id=3, type="contrast", text="also good"),
    ]))
    plan = await plan_queries("q", "ru", {}, llm=llm)
    assert [sq.text for sq in plan.sub_queries] == ["good", "also good"]
    assert [sq.id for sq in plan.sub_queries] == [0, 1]


@pytest.mark.asyncio
async def test_alt_phrasings_cleaned_of_empty_strings() -> None:
    """SubQuery schema caps alt_phrasings at 2 already; here we just verify
    the `_clean` step strips whitespace-only / empty alt entries."""
    llm = FakeLLM(QueryPlan(sub_queries=[
        SubQuery(id=0, type="definition", text="x",
                 alt_phrasings=["one", "  "]),
    ]))
    plan = await plan_queries("q", "ru", {}, llm=llm)
    assert plan.sub_queries[0].alt_phrasings == ["one"]


@pytest.mark.asyncio
async def test_empty_llm_output_falls_back_to_question() -> None:
    llm = FakeLLM(QueryPlan(sub_queries=[]))
    plan = await plan_queries("вопрос про карму", "ru", {}, llm=llm)
    assert len(plan.sub_queries) == 1
    assert plan.sub_queries[0].text == "вопрос про карму"
    assert plan.sub_queries[0].type == "general"


@pytest.mark.asyncio
async def test_llm_failure_falls_back_to_question() -> None:
    def boom(*args, **kwargs):
        raise RuntimeError("openrouter 503")
    llm = FakeLLM(boom)
    plan = await plan_queries("вопрос", "ru", {}, llm=llm)
    assert len(plan.sub_queries) == 1
    assert plan.sub_queries[0].text == "вопрос"
    assert plan.sub_queries[0].type == "general"


@pytest.mark.asyncio
async def test_router_args_propagated_to_prompt() -> None:
    llm = FakeLLM(QueryPlan(sub_queries=[
        SubQuery(id=0, type="general", text="x"),
    ]))
    await plan_queries(
        "про карму", "ru",
        {"tag_hints": ["карма"], "author": "Прабхупада"},
        llm=llm,
    )
    user_msg = next(m["content"] for m in llm.calls[0][0] if m["role"] == "user")
    assert "tag_hints" in user_msg
    assert "Прабхупада" in user_msg


@pytest.mark.asyncio
async def test_passes_model_override() -> None:
    llm = FakeLLM(QueryPlan(sub_queries=[
        SubQuery(id=0, type="general", text="x"),
    ]))
    await plan_queries(
        "q", "ru", {}, llm=llm,
        model="openrouter/google/gemini-3.1-flash-lite",
    )
    _, _, model = llm.calls[0]
    assert model == "openrouter/google/gemini-3.1-flash-lite"
