"""Unit tests for the clarify_worker node — the deterministic terminal that
asks a grounded question when a deictic request can't be resolved (no current
lecture / no listen-history)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes import clarify_worker as cw


@dataclass
class _Ctx:
    lang: str = "ru"
    request_id: str = "req-test"


@dataclass
class _Runtime:
    context: _Ctx


@pytest.fixture
def _events(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    captured: list[dict] = []
    monkeypatch.setattr(cw, "get_stream_writer", lambda: captured.append)
    return captured


async def _text(events: list[dict]) -> str:
    return "".join(e["data"]["text"] for e in events if e["type"] == "delta")


async def test_points_at_lecture_asks_to_name_or_sync(_events) -> None:
    # current_ref / recent_ref → "which lecture" prompt.
    await cw.clarify_worker_node(
        {"intent": "research", "extracted_args": {"recent_ref": True}},
        _Runtime(_Ctx(lang="ru")),
    )
    text = await _text(_events)
    assert "какую лекцию" in text.lower() or "назовите лекцию" in text.lower()
    assert not [e for e in _events if e["type"] == "action"]  # a question, no cards


async def test_history_query_asks_for_topic(_events) -> None:
    # history_ref (time window) with no history → "name a topic/author/book".
    await cw.clarify_worker_node(
        {"intent": "find_track", "extracted_args": {"history_ref": True}},
        _Runtime(_Ctx(lang="ru")),
    )
    text = await _text(_events)
    assert "истории" in text.lower()


async def test_english_locale(_events) -> None:
    await cw.clarify_worker_node(
        {"intent": "find_track", "extracted_args": {"history_ref": True}},
        _Runtime(_Ctx(lang="en")),
    )
    text = await _text(_events)
    assert "listening history" in text.lower()


async def test_unknown_locale_falls_back_to_english(_events) -> None:
    await cw.clarify_worker_node(
        {"intent": "research", "extracted_args": {"current_ref": True}},
        _Runtime(_Ctx(lang="hi")),
    )
    text = await _text(_events)
    assert "lecture" in text.lower()
