"""Tests for `application/followup_rewrite.py` — resolving a context-dependent
follow-up into a self-contained query before classification.

A `FakeLLM` returns a scripted `FollowupRewrite`; we assert the gate (no call on
first turn / long messages) and the rewrite/pass-through behaviour.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TypeVar

import pytest
from pydantic import BaseModel

from lectorium_chat.application.followup_rewrite import (
    FollowupRewrite,
    resolve_followup_query,
)
from lectorium_chat.domain.entities import Message

T = TypeVar("T", bound=BaseModel)


@dataclass
class FakeLLM:
    response: FollowupRewrite | None = None
    raises: bool = False
    calls: int = 0

    async def structured_output(
        self, messages: list[Message], schema: type[T], *,
        model: str | None = None, callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T:
        self.calls += 1
        if self.raises:
            raise RuntimeError("boom")
        return self.response  # type: ignore[return-value]


_HIST = [
    {"role": "user", "content": "Что говорится об асурах в 16 главе БГ?"},
    {"role": "assistant", "content": "В 16-й главе описаны демонические качества…"},
]


@pytest.mark.asyncio
async def test_no_history_returns_unchanged_without_call() -> None:
    llm = FakeLLM()
    out = await resolve_followup_query(None, "А ещё?", llm=llm)
    assert out == "А ещё?"
    assert llm.calls == 0  # gate: first turn → no LLM


@pytest.mark.asyncio
async def test_long_message_is_skipped() -> None:
    llm = FakeLLM()
    q = "Объясни подробно природу демонических личностей по тексту шестнадцатой главы Гиты"
    out = await resolve_followup_query(_HIST, q, llm=llm)
    assert out == q
    assert llm.calls == 0  # >8 words → assumed self-contained


@pytest.mark.asyncio
async def test_short_followup_is_rewritten() -> None:
    llm = FakeLLM(response=FollowupRewrite(query="Ещё стихи БГ о природе асуров"))
    out = await resolve_followup_query(_HIST, "А ещё?", llm=llm)
    assert out == "Ещё стихи БГ о природе асуров"
    assert llm.calls == 1


@pytest.mark.asyncio
async def test_self_contained_short_passes_through() -> None:
    # The model judged it self-contained and echoed it back verbatim.
    llm = FakeLLM(response=FollowupRewrite(query="Кто такой Кришна?"))
    out = await resolve_followup_query(_HIST, "Кто такой Кришна?", llm=llm)
    assert out == "Кто такой Кришна?"


@pytest.mark.asyncio
async def test_llm_failure_returns_unchanged() -> None:
    llm = FakeLLM(raises=True)
    out = await resolve_followup_query(_HIST, "А ещё?", llm=llm)
    assert out == "А ещё?"  # never fail the turn on the rewrite


@pytest.mark.asyncio
async def test_empty_rewrite_falls_back_to_original() -> None:
    llm = FakeLLM(response=FollowupRewrite(query="   "))
    out = await resolve_followup_query(_HIST, "А ещё?", llm=llm)
    assert out == "А ещё?"
