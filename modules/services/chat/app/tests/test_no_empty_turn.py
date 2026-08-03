"""A turn must never end with the user staring at nothing.

Three production turns in two weeks did. Each had its own cause, and this file
pins the two ends of the fix:

- `localized_reply` asked for a one-line reply plus up to three chips as
  structured JSON, and BOTH the primary and the fallback model failed to emit
  parseable JSON for it. Something that small must not lose a turn, so the
  retry drops the envelope — there is no parse step left to miss.
- whatever still slips through (a 429 with nothing left to escalate to, or the
  third trace, whose observations stop after `topic_extractor` with no
  synthesizer and no error at all) converges on one place: `run_chat_turn`,
  which is the only code that can see the whole turn produced no output.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from lectorium_chat.agent.graph.nodes._worker_common import localized_reply
from lectorium_chat.application import chat_turn
from lectorium_chat.application.chat_turn import run_chat_turn


# ── localized_reply: a parse miss must not cost the line ──────────────────


@dataclass
class _LLM:
    """Structured output fails the way it failed on production; the plain-text
    path is what has to save the turn."""

    structured_raises: bool = True
    text: str = "К сожалению, ничего не нашлось."
    text_raises: bool = False
    structured_calls: int = 0
    text_calls: list[str] = field(default_factory=list)

    async def structured_output(self, messages, schema, **_kw):
        self.structured_calls += 1
        if self.structured_raises:
            raise RuntimeError(
                "structured_output: no parseable LocalizedReply JSON in model output"
            )
        return schema(line="from json", chips=["chip"])

    async def text_completion(self, messages, **_kw):
        self.text_calls.append(messages[0]["content"])
        if self.text_raises:
            raise RuntimeError("provider down")
        return self.text


@dataclass
class _Ctx:
    llm: Any
    lang: str = "ru"
    request_id: str = "req-1"
    kv_cache: Any | None = None


async def test_a_json_miss_falls_back_to_plain_text() -> None:
    llm = _LLM()
    reply = await localized_reply(_Ctx(llm), "No lectures were found on BG 2.13.")

    assert reply.line == "К сожалению, ничего не нашлось."
    assert llm.structured_calls == 1
    # Same writing instructions, no envelope — that is the whole point.
    assert "No JSON" in llm.text_calls[0]


async def test_the_plain_retry_drops_chips_but_not_the_line() -> None:
    # Chips are a nicety; a blank bubble is not an option.
    reply = await localized_reply(_Ctx(_LLM()), "Ask whether they want the verses.")
    assert reply.chips == []
    assert reply.line


async def test_a_working_json_call_pays_no_second_call() -> None:
    llm = _LLM(structured_raises=False)
    reply = await localized_reply(_Ctx(llm), "Found 3 lectures.")
    assert reply.line == "from json"
    assert reply.chips == ["chip"]
    assert llm.text_calls == []


async def test_both_paths_failing_still_does_not_raise() -> None:
    # The turn survives; the empty line is then caught by the backstop below.
    reply = await localized_reply(
        _Ctx(_LLM(text_raises=True)), "Say we found nothing."
    )
    assert reply.line == ""


async def test_the_rescued_line_is_cached_like_any_other() -> None:
    # These replies are deterministic per (situation, lang), and a line rescued
    # from the plain-text path is no less reusable — otherwise every turn on
    # this situation pays two calls.
    store: dict[str, bytes] = {}

    class _Cache:
        async def get(self, key: str) -> bytes | None:
            return store.get(key)

        async def set(self, key: str, value: bytes, *, ttl_s: int) -> None:
            store[key] = value

    llm = _LLM()
    ctx = _Ctx(llm, kv_cache=_Cache())
    first = await localized_reply(ctx, "No lectures were found on BG 2.13.")
    second = await localized_reply(ctx, "No lectures were found on BG 2.13.")

    assert first.line == second.line
    assert llm.structured_calls == 1
    assert len(llm.text_calls) == 1


# ── run_chat_turn: the backstop ───────────────────────────────────────────


class _Graph:
    def __init__(self, events: list[tuple[str, dict]]) -> None:
        self._events = events

    async def astream(self, _state, *, context, stream_mode):  # noqa: ARG002
        for ev_type, data in self._events:
            yield ("custom", {"type": ev_type, "data": data})


@dataclass
class _Settings:
    library_db_path: str = "/tmp/x.db"
    embed_model: str = "fake-embed"
    embed_dim: int = 1536


@dataclass
class _Deps:
    settings: _Settings
    chat_graph: Any
    llm: Any
    embedder: Any = None
    chunk_repo: Any = None
    catalog_repo: Any = None
    pool: Any = None
    kv_cache: Any = None
    reranker: Any = None


@asynccontextmanager
async def _no_trace(*_a, **_k):
    yield None


async def _run(events: list[tuple[str, dict]]) -> list[Any]:
    deps = _Deps(
        settings=_Settings(), chat_graph=_Graph(events), llm=MagicMock(),
        catalog_repo=MagicMock(),
    )
    with patch.object(chat_turn, "get_langfuse", return_value=None), \
         patch.object(chat_turn, "with_langfuse_trace", _no_trace):
        return [
            ev async for ev in run_chat_turn(
                history=[{"role": "user", "content": "Случайность"}],
                lang="ru", request_id="r-empty", deps=deps,
            )
        ]


async def test_a_turn_with_no_output_reports_an_error_instead_of_done() -> None:
    # `agent_error` is already localised on every client and already refunds the
    # quota — an answer that never arrived must not be charged for.
    events = await _run([("status", {"key": "thinking"})])

    assert [e.type for e in events] == ["status", "error"]
    assert events[-1].data["code"] == "agent_error"


async def test_whitespace_only_prose_counts_as_no_output() -> None:
    events = await _run([("delta", {"text": "   \n"})])
    assert events[-1].type == "error"


async def test_a_turn_that_said_something_ends_with_done() -> None:
    events = await _run([("delta", {"text": "Ответ."})])
    assert events[-1].type == "done"


async def test_an_action_only_turn_is_not_empty() -> None:
    # The user got a tappable card; prose around it is optional. Without this
    # carve-out the backstop would turn a working flow into an error.
    events = await _run([
        ("action", {"kind": "media", "id": "a1", "payload": {}}),
    ])
    assert events[-1].type == "done"


async def test_a_failed_turn_is_not_double_reported() -> None:
    # The graph already told the user; a second error frame would render a
    # second failed bubble.
    events = await _run([("error", {"code": "chat_unavailable", "message": "x"})])
    assert [e.type for e in events] == ["error", "done"]
    assert events[0].data["code"] == "chat_unavailable"


@pytest.mark.parametrize("prose", ["Ответ.", "[card:track_x]"])
async def test_marker_only_prose_is_output_too(prose: str) -> None:
    # A card block streamed as prose IS what the user reads.
    events = await _run([("delta", {"text": prose})])
    assert events[-1].type == "done"
