"""Unit tests for research.query_expander."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel

from shruti_chat.research.models import ExpansionResult
from shruti_chat.research.query_expander import expand_query


class FakeLLM:
    """Records the messages and returns a scripted ExpansionResult.
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
async def test_returns_clean_queries_capped_at_5() -> None:
    llm = FakeLLM(ExpansionResult(queries=["a", "b", "c", "d", "e", "f", "g"]))
    result = await expand_query("что такое разум", "ru", {}, llm=llm)
    assert len(result.queries) == 5
    assert result.queries[:5] == ["a", "b", "c", "d", "e"]


@pytest.mark.asyncio
async def test_strips_empty_and_whitespace_queries() -> None:
    llm = FakeLLM(ExpansionResult(queries=["природа buddhi", "   ", "", "intelligence vs mind"]))
    result = await expand_query("разум", "ru", {}, llm=llm)
    assert result.queries == ["природа buddhi", "intelligence vs mind"]


@pytest.mark.asyncio
async def test_empty_llm_output_falls_back_to_question() -> None:
    llm = FakeLLM(ExpansionResult(queries=[]))
    result = await expand_query("вопрос про карму", "ru", {}, llm=llm)
    assert result.queries == ["вопрос про карму"]


@pytest.mark.asyncio
async def test_llm_failure_falls_back_to_question() -> None:
    def boom(*args, **kwargs):
        raise RuntimeError("openrouter 503")
    llm = FakeLLM(boom)
    result = await expand_query("вопрос", "ru", {}, llm=llm)
    assert result.queries == ["вопрос"]


@pytest.mark.asyncio
async def test_router_args_propagated_to_prompt() -> None:
    llm = FakeLLM(ExpansionResult(queries=["x"]))
    await expand_query("про карму", "ru", {"tag_hints": ["карма"], "author": "Прабхупада"}, llm=llm)
    # User message should mention router_args.
    user_msg = next(m["content"] for m in llm.calls[0][0] if m["role"] == "user")
    assert "tag_hints" in user_msg
    assert "Прабхупада" in user_msg


@pytest.mark.asyncio
async def test_passes_model_override() -> None:
    llm = FakeLLM(ExpansionResult(queries=["x"]))
    await expand_query("q", "ru", {}, llm=llm, model="openrouter/google/gemini-3.1-flash-lite")
    _, _, model = llm.calls[0]
    assert model == "openrouter/google/gemini-3.1-flash-lite"
