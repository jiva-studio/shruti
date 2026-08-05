"""Serving prompts from the image copy must not be silent.

`LangfusePromptHandle.from_langfuse` existed all along, documented as the
signal that "operators can spot when prompts are being served stale" — with
zero readers. No log, no metric, no `/status` field. So a Langfuse outage
silently reverted every prompt to whatever was baked into the image, which
`pull` only refreshes by hand and can therefore be arbitrarily far behind the
live text. The service kept answering; the answers were just produced by
different instructions than anyone thought.
"""

from __future__ import annotations

from typing import Any

import pytest

from lectorium_chat.observability import langfuse_client as lc
from lectorium_chat.observability.metrics import (
    prompt_fetch_counter,
    prompt_source_summary,
)


class _StubPrompt:
    version = 3
    labels = ["production"]
    config: dict[str, Any] = {}

    def compile(self) -> str:
        return "live text"


class _StubLangfuse:
    def get_prompt(self, name: str, **kw: Any) -> _StubPrompt:
        return _StubPrompt()


def _count(name: str, source: str) -> float:
    return prompt_fetch_counter.labels(name=name, source=source)._value.get()


def test_a_live_fetch_is_counted_as_langfuse(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lc, "_LANGFUSE", _StubLangfuse())
    monkeypatch.setattr(lc, "_force_fallback", lambda: False)
    before = _count("chat-router", "langfuse")

    lc.prompt_with_fallback("chat-router", fallback="disk")

    assert _count("chat-router", "langfuse") == before + 1


def test_a_fallback_is_counted_separately(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lc, "_LANGFUSE", None)
    before = _count("query-planner", "fallback")

    handle = lc.prompt_with_fallback("query-planner", fallback="disk")

    assert handle.from_langfuse is False
    assert _count("query-planner", "fallback") == before + 1


def test_an_outage_mid_fetch_counts_as_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The case that used to be invisible: Langfuse configured, reachable at
    boot, failing now."""

    class _Broken:
        def get_prompt(self, name: str, **kw: Any):
            raise RuntimeError("langfuse down")

    monkeypatch.setattr(lc, "_LANGFUSE", _Broken())
    monkeypatch.setattr(lc, "_force_fallback", lambda: False)
    before = _count("topic-extractor", "fallback")

    handle = lc.prompt_with_fallback("topic-extractor", fallback="disk")

    assert handle.from_langfuse is False
    assert _count("topic-extractor", "fallback") == before + 1


def test_status_summary_names_what_is_on_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`serving_from_fallback` is the actionable part — knowing the count
    without the names tells an operator nothing to act on."""
    monkeypatch.setattr(lc, "_LANGFUSE", None)

    lc.prompt_with_fallback("caption-generator", fallback="disk")
    summary = prompt_source_summary()

    assert "caption-generator" in summary["serving_from_fallback"]
    assert summary["fetches_from_fallback"] >= 1


def test_summary_reads_the_counter_rather_than_a_second_tally() -> None:
    """One source of truth, so /status and /metrics cannot disagree."""
    before = prompt_source_summary()["fetches_from_langfuse"]
    prompt_fetch_counter.labels(name="chat-section-header", source="langfuse").inc()

    assert prompt_source_summary()["fetches_from_langfuse"] == before + 1
