"""The `error` frame carries a code and a fixed string — never the exception.

Production shipped an upstream provider's own words to a user: the internal
model id, the provider name and a link to the provider's settings page, because
the frame was built as `{"code": code, "message": str(exc)}`. The same three
`chat_graph_failed` events also show the other half of the bug — two of them had
an exception whose `str()` was empty, so the frame carried `message: ""`.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

from shruti_chat.agent import llm_loop
from shruti_chat.agent.events import ERROR_MESSAGES, error_event
from shruti_chat.application import chat_turn
from shruti_chat.application.chat_turn import run_chat_turn
from shruti_chat.application.chat_turn_request import ChatTurnRequest
from shruti_chat.application.proactive_turn import run_proactive_turn
from shruti_chat.domain.ports.llm_provider import ProviderUnavailable

# The verbatim string a user was shown.
LEAK = (
    "google/gemini-3.1-flash-lite is temporarily rate-limited upstream. Please retry "
    "shortly, or add your own key to accumulate your rate limits: "
    "https://openrouter.ai/settings/integrations"
)


# ── error_event ───────────────────────────────────────────────────────────


def test_every_code_resolves_to_a_non_empty_message() -> None:
    for code in (*ERROR_MESSAGES, "some_code_no_client_knows"):
        assert error_event(code).data["message"].strip()


def test_a_blank_message_falls_back_instead_of_shipping_nothing() -> None:
    # `str(exc)` is empty for a bare `RuntimeError()`; the client must not be
    # handed an empty string to render.
    for blank in (None, "", "   "):
        assert error_event("agent_error", blank).data["message"] == (
            ERROR_MESSAGES["agent_error"]
        )


def test_a_caller_specific_note_is_kept() -> None:
    assert error_event("agent_error", "note").data["message"] == "note"


def test_the_frame_shape_is_unchanged() -> None:
    ev = error_event("chat_unavailable")
    assert ev.type == "error"
    assert set(ev.data) == {"code", "message"}


# ── run_chat_turn: a failing graph ────────────────────────────────────────


class _RaisingGraph:
    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    async def astream(self, _state, *, context: Any, stream_mode: Any):
        raise self._exc
        yield  # pragma: no cover — makes this an async generator


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


async def _run(exc: BaseException) -> list[Any]:
    deps = _Deps(
        settings=_Settings(), chat_graph=_RaisingGraph(exc), llm=MagicMock(),
        catalog_repo=MagicMock(),
    )
    with patch.object(chat_turn, "get_langfuse", return_value=None), \
         patch.object(chat_turn, "with_langfuse_trace", _no_trace):
        return [
            ev async for ev in run_chat_turn(
                ChatTurnRequest(
                    history=[{"role": "user", "content": "Случайность"}],
                    lang="ru", request_id="r-fail",
                ),
                deps=deps,
            )
        ]


async def test_the_provider_message_never_reaches_the_client() -> None:
    events = await _run(ProviderUnavailable(LEAK))

    assert [e.type for e in events] == ["error"]
    assert events[0].data["code"] == "chat_unavailable"
    message = events[0].data["message"]
    assert message == ERROR_MESSAGES["chat_unavailable"]
    for secret in ("gemini", "openrouter", "http", "rate-limited"):
        assert secret not in message.lower()


async def test_a_graph_bug_stays_a_generic_agent_error() -> None:
    events = await _run(RuntimeError("KeyError: 'chunk_repo' in synthesizer_node"))

    assert events[0].data["code"] == "agent_error"
    assert events[0].data["message"] == ERROR_MESSAGES["agent_error"]


async def test_a_message_less_exception_still_says_something() -> None:
    events = await _run(RuntimeError())

    assert events[0].data["code"] == "agent_error"
    assert events[0].data["message"].strip()


# ── run_llm_loop: the other half of the same bug ──────────────────────────
#
# `run_chat_turn` is the graph path; `run_llm_loop` is the tool-calling loop
# behind `run_proactive_turn`, and it built its error frames the same way.
# Nothing drove it, so its `str(exc)` could be restored without a red test.


class _Delta:
    def __init__(self, content: Any = None, tool_calls: Any = None) -> None:
        self.content = content
        self.tool_calls = tool_calls


class _Chunk:
    """Shapes the attribute access `run_llm_loop` does on a litellm chunk."""

    def __init__(self, content: Any = None, tool_calls: Any = None) -> None:
        self.choices = [SimpleNamespace(delta=_Delta(content, tool_calls))]
        self.usage = None


def _tool_call_delta() -> Any:
    return SimpleNamespace(
        index=0, id="c1",
        function=SimpleNamespace(name="chunks_search", arguments='{"q":"x"}'),
    )


def _failing_stream(exc: BaseException, *, after_text: str | None = None):
    async def _stream(**_kwargs: Any):
        if after_text is not None:
            yield _Chunk(content=after_text)
        raise exc

    return _stream


async def _always_calls_a_tool(**_kwargs: Any):
    yield _Chunk(tool_calls=[_tool_call_delta()])


async def _run_loop(stream: Any, *, max_tool_turns: int = 10) -> list[Any]:
    with patch.object(llm_loop.llm, "stream_completion", stream):
        return [
            ev async for ev in llm_loop.run_llm_loop(
                [{"role": "user", "content": "Случайность"}],
                tools={}, tool_schemas=[], emits_events=(),
                lang="ru", model="fake/model", request_id="r-loop",
                max_tool_turns=max_tool_turns,
            )
        ]


async def test_the_loop_never_ships_the_provider_message_either() -> None:
    events = await _run_loop(_failing_stream(ProviderUnavailable(LEAK)))

    assert [e.type for e in events] == ["error"]
    assert events[0].data["code"] == "chat_unavailable"
    message = events[0].data["message"]
    assert message == ERROR_MESSAGES["chat_unavailable"]
    for secret in ("gemini", "openrouter", "http", "rate-limited"):
        assert secret not in message.lower()


async def test_the_leak_is_still_closed_once_prose_has_streamed() -> None:
    # The failure that shipped happened mid-answer: deltas were already on the
    # wire, so the sanitised frame has to hold on the late path too.
    events = await _run_loop(
        _failing_stream(ProviderUnavailable(LEAK), after_text="Итак, ")
    )

    assert [e.type for e in events] == ["delta", "error"]
    assert events[-1].data["message"] == ERROR_MESSAGES["chat_unavailable"]


async def test_a_loop_bug_stays_a_generic_agent_error() -> None:
    events = await _run_loop(
        _failing_stream(RuntimeError("KeyError: 'chunk_repo' in tool registry"))
    )

    assert events[-1].data["code"] == "agent_error"
    assert events[-1].data["message"] == ERROR_MESSAGES["agent_error"]
    assert "chunk_repo" not in events[-1].data["message"]


async def test_a_message_less_exception_in_the_loop_says_something() -> None:
    events = await _run_loop(_failing_stream(RuntimeError()))

    assert events[-1].data["code"] == "agent_error"
    assert events[-1].data["message"].strip()


async def test_running_out_of_turns_reports_no_internal_counter() -> None:
    # The old frame read "agent exceeded 10 tool turns" — an internal knob
    # the user can neither act on nor understand.
    events = await _run_loop(_always_calls_a_tool, max_tool_turns=1)

    assert events[-1].type == "error"
    assert events[-1].data["code"] == "max_turns_exceeded"
    assert events[-1].data["message"] == ERROR_MESSAGES["max_turns_exceeded"]
    assert "tool turns" not in events[-1].data["message"]


# ── run_proactive_turn: the loop as the client actually reaches it ────────


async def test_a_proactive_turn_leaks_nothing_end_to_end() -> None:
    with patch.object(
        llm_loop.llm, "stream_completion",
        _failing_stream(ProviderUnavailable(LEAK)),
    ):
        events = [
            ev async for ev in run_proactive_turn(
                "inactivity", {"days_away": 7}, lang="ru", request_id="r-pro",
            )
        ]

    assert [e.type for e in events] == ["error"]
    assert events[0].data["message"] == ERROR_MESSAGES["chat_unavailable"]
    assert LEAK not in events[0].data["message"]


# ── the choke point covers every emitter ─────────────────────────────────


def test_the_budget_timeout_code_has_a_client_string() -> None:
    # `turn_timeout` (turn_runner) is emitted straight onto the wire as a raw
    # SSE frame, so it is the one code most likely to drift out of the ladder.
    assert ERROR_MESSAGES["turn_timeout"].strip()
