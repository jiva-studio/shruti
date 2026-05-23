"""Unit tests for research.topic_extractor."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel

from shruti_chat.research.models import TopicExtractionResult
from shruti_chat.research.topic_extractor import extract_topics


class FakeLLM:
    def __init__(self, script: Any) -> None:
        self.script = script
        self.calls: list[tuple[list[dict], type[BaseModel], str | None]] = []

    async def structured_output(self, messages: list[dict], schema: type[BaseModel], *, model: str | None = None, **_extra):
        self.calls.append((messages, schema, model))
        if callable(self.script):
            return self.script(messages, schema, model)
        return self.script


@pytest.mark.asyncio
async def test_extracts_2_to_5_topics() -> None:
    llm = FakeLLM(TopicExtractionResult(topics=["природа разума", "buddhi", "иерархия сознания"]))
    out = await extract_topics("что такое разум", "ru", ["природа buddhi"], llm=llm)
    assert out == ["природа разума", "buddhi", "иерархия сознания"]


@pytest.mark.asyncio
async def test_caps_at_max_topics() -> None:
    too_many = TopicExtractionResult(topics=[f"topic_{i}" for i in range(7)])
    llm = FakeLLM(too_many)
    out = await extract_topics("q", "ru", [], llm=llm)
    assert len(out) == 5  # TOPIC_MAX_TOPICS_EXTRACTED


@pytest.mark.asyncio
async def test_empty_on_chitchat() -> None:
    llm = FakeLLM(TopicExtractionResult(topics=[]))
    out = await extract_topics("спасибо!", "ru", [], llm=llm)
    assert out == []


@pytest.mark.asyncio
async def test_timeout_returns_empty() -> None:
    def boom(*args, **kwargs):
        raise TimeoutError("openrouter timeout")
    llm = FakeLLM(boom)
    out = await extract_topics("q", "ru", [], llm=llm)
    assert out == []


@pytest.mark.asyncio
async def test_handles_malformed_response() -> None:
    def boom(*args, **kwargs):
        raise ValueError("invalid JSON")
    llm = FakeLLM(boom)
    out = await extract_topics("q", "ru", [], llm=llm)
    assert out == []


@pytest.mark.asyncio
async def test_strips_whitespace_topics() -> None:
    llm = FakeLLM(TopicExtractionResult(topics=["  buddhi  ", "", "карма"]))
    out = await extract_topics("q", "ru", [], llm=llm)
    assert out == ["buddhi", "карма"]
