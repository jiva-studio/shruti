"""Unit tests for the clarify_worker node — the deterministic terminal that
asks a grounded question (LLM-localized to the user's language) when a deictic
request can't be resolved (no current lecture / no listen-history)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from shruti_chat.agent.graph.nodes import clarify_worker as cw


class _FakeLLM:
    """Echoes the situation so the test can assert which prompt was chosen,
    and returns a marker line so the emit path is exercised."""

    def __init__(self) -> None:
        self.situations: list[str] = []

    async def structured_output(self, messages, schema, *, run_name=None, model=None, callbacks=None):
        situation = messages[-1]["content"]
        self.situations.append(situation)
        return schema(line="LOCALIZED_LINE", chips=[])


@dataclass
class _Ctx:
    llm: Any = field(default_factory=_FakeLLM)
    lang_code: str = "ru"
    request_id: str = "req-test"
    kv_cache: Any | None = None


@dataclass
class _Runtime:
    context: _Ctx


@pytest.fixture
def _events(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    captured: list[dict] = []
    monkeypatch.setattr(cw, "get_stream_writer", lambda: captured.append)
    return captured


def _text(events: list[dict]) -> str:
    return "".join(e["data"]["text"] for e in events if e["type"] == "delta")


async def test_points_at_lecture_uses_which_lecture_prompt(_events) -> None:
    # current_ref / recent_ref → the "name the lecture / enable sync" situation.
    llm = _FakeLLM()
    await cw.clarify_worker_node(
        {"intent": "research", "extracted_args": {"recent_ref": True}},
        _Runtime(_Ctx(llm=llm)),
    )
    assert "LOCALIZED_LINE" in _text(_events)          # localized line streamed
    assert not [e for e in _events if e["type"] == "action"]  # a question, no cards
    assert "specific lecture" in llm.situations[0]      # picked the right prompt
    assert "enable listening sync" in llm.situations[0]


async def test_history_query_uses_no_history_prompt(_events) -> None:
    # history_ref (time window) → the "name a topic/author/book" situation.
    llm = _FakeLLM()
    await cw.clarify_worker_node(
        {"intent": "find_track", "extracted_args": {"history_ref": True}},
        _Runtime(_Ctx(llm=llm)),
    )
    assert "LOCALIZED_LINE" in _text(_events)
    assert "no listening history" in llm.situations[0]
    assert "topic, author, or book" in llm.situations[0]


async def test_language_is_passed_to_localizer(_events) -> None:
    # The user's language reaches the localizer, so ANY locale is covered (not a
    # hardcoded ru/en pair).
    llm = _FakeLLM()
    await cw.clarify_worker_node(
        {"intent": "research", "extracted_args": {"current_ref": True}},
        _Runtime(_Ctx(llm=llm, lang_code="hi")),
    )
    assert "hi" in llm.situations[0]  # "Language code: hi" is in the prompt
