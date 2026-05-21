"""Unit tests for `caption_generator` — background topic-tag pass."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from lectorium_chat.research.caption_generator import generate_captions, _CaptionResult


@dataclass
class _FakeLLM:
    """Returns a pre-canned `_CaptionResult` from `structured_output`,
    or raises if `should_raise` is True."""

    payload: dict[str, str]
    should_raise: bool = False

    async def structured_output(self, messages, model_cls, model=None):
        if self.should_raise:
            raise RuntimeError("LLM down")
        return model_cls(captions=self.payload)


@pytest.mark.asyncio
async def test_generate_captions_writes_into_dict() -> None:
    captions_out: dict[int, str] = {}
    llm = _FakeLLM(payload={"1": "природа атмы", "2": "вечность души"})
    await generate_captions(
        [(1, "Soul changes bodies…"), (2, "Eternal nature…")],
        user_question="что такое душа",
        lang="ru",
        llm=llm,
        captions_out=captions_out,
    )
    assert captions_out == {1: "природа атмы", 2: "вечность души"}


@pytest.mark.asyncio
async def test_generate_captions_empty_input_no_call() -> None:
    """No targets → no LLM call. Safe early-return."""
    captions_out: dict[int, str] = {}
    llm = _FakeLLM(payload={"1": "x"}, should_raise=True)  # would raise if called
    await generate_captions(
        [], user_question="q", lang="ru", llm=llm, captions_out=captions_out,
    )
    assert captions_out == {}


@pytest.mark.asyncio
async def test_generate_captions_llm_failure_silent() -> None:
    """Best-effort: any LLM error leaves captions empty. The expander
    then degrades the cite chip to title + timestamp only."""
    captions_out: dict[int, str] = {}
    llm = _FakeLLM(payload={}, should_raise=True)
    await generate_captions(
        [(1, "text")], user_question="q", lang="ru", llm=llm,
        captions_out=captions_out,
    )
    assert captions_out == {}


@pytest.mark.asyncio
async def test_generate_captions_drops_blank_values() -> None:
    """LLM sometimes returns empty strings for chunks it couldn't
    summarise. Skip those — empty caption gives the audio chip
    nothing to render."""
    captions_out: dict[int, str] = {}
    llm = _FakeLLM(payload={"1": "природа атмы", "2": "", "3": "   "})
    await generate_captions(
        [(1, "a"), (2, "b"), (3, "c")],
        user_question="q", lang="ru", llm=llm, captions_out=captions_out,
    )
    assert captions_out == {1: "природа атмы"}


@pytest.mark.asyncio
async def test_generate_captions_skips_non_integer_keys() -> None:
    """LLM may JSON-malform with non-numeric keys — skip those rather
    than crash the background task."""
    captions_out: dict[int, str] = {}
    llm = _FakeLLM(payload={"1": "ok", "bad-key": "x"})
    await generate_captions(
        [(1, "a")],
        user_question="q", lang="ru", llm=llm, captions_out=captions_out,
    )
    assert captions_out == {1: "ok"}
