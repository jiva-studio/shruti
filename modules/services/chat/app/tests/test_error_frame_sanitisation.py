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
from typing import Any
from unittest.mock import MagicMock, patch

from shruti_chat.agent.events import ERROR_MESSAGES, error_event
from shruti_chat.application import chat_turn
from shruti_chat.application.chat_turn import run_chat_turn
from shruti_chat.application.chat_turn_request import ChatTurnRequest
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
