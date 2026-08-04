"""Settled attributes leave the turn on `done`, not as their own event.

That is what closes the loop. The client stores the map on the assistant
message AND folds it into the aggregate it sends back as request metadata — so
a language the user asked for survives both the 20-message history cap and an
app restart. If it stayed inside the turn, the switch would die the moment the
request scrolled out of the window.

Same route `aliases` already takes.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

from lectorium_chat.application import chat_turn
from lectorium_chat.application.chat_turn import run_chat_turn
from lectorium_chat.application.chat_turn_request import ChatTurnRequest
from lectorium_chat.application.conversation_attributes import remembered_attributes
from lectorium_chat.domain.conversation_attributes import REPLY_LANGUAGE


_SETTLED = {REPLY_LANGUAGE: {"value": "ru", "label": "Русский", "explicit": True}}


class _GraphThatSettles:
    """Stands in for the graph: the router emits the custom event after
    merging, then the answer streams."""

    async def astream(self, _state, *, context, stream_mode):  # noqa: ARG002
        yield ("custom", {"type": "attributes", "data": dict(_SETTLED)})
        yield ("custom", {"type": "delta", "data": {"text": "Ответ."}})


class _GraphThatSettlesNothing:
    async def astream(self, _state, *, context, stream_mode):  # noqa: ARG002
        yield ("custom", {"type": "delta", "data": {"text": "Answer."}})


class _GraphRecordingState:
    """Captures the initial state so the request-level aggregate can be
    followed all the way into the graph."""

    def __init__(self) -> None:
        self.state: dict[str, Any] = {}

    async def astream(self, state, *, context, stream_mode):  # noqa: ARG002
        self.state = dict(state)
        yield ("custom", {"type": "delta", "data": {"text": "ok"}})


@dataclass
class _FakeSettings:
    library_db_path: str = "/tmp/x.db"
    embed_model: str = "fake-embed"
    embed_dim: int = 1536


@dataclass
class _FakeDeps:
    settings: _FakeSettings
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


async def _events(graph: Any, **kwargs: Any) -> list[Any]:
    deps = _FakeDeps(
        settings=_FakeSettings(), chat_graph=graph, llm=MagicMock(),
        catalog_repo=MagicMock(),
    )
    with patch.object(chat_turn, "get_langfuse", return_value=None), \
         patch.object(chat_turn, "with_langfuse_trace", _no_trace):
        return [
            ev async for ev in run_chat_turn(
                ChatTurnRequest(
                    history=[{"role": "user", "content": "отвечай по-русски"}],
                    lang="en", request_id="r-attrs-1", **kwargs,
                ),
                deps=deps,
            )
        ]


async def test_done_carries_the_settled_attributes() -> None:
    done = [e for e in await _events(_GraphThatSettles()) if e.type == "done"]
    assert len(done) == 1
    assert done[0].data["attributes"] == _SETTLED


async def test_attributes_are_not_a_client_facing_event() -> None:
    # Per-message server state, not something to render mid-stream.
    events = await _events(_GraphThatSettles())
    assert [e.type for e in events] == ["delta", "done"]


async def test_done_omits_them_when_nothing_was_settled() -> None:
    # Absent, not empty: the client keeps what it had, and the app locale stays
    # in force.
    done = [e for e in await _events(_GraphThatSettlesNothing()) if e.type == "done"][0]
    assert "attributes" not in done.data


async def test_the_clients_aggregate_reaches_the_graph() -> None:
    graph = _GraphRecordingState()
    await _events(graph, client_attributes=_SETTLED)
    assert graph.state["client_attributes"] == _SETTLED


async def test_no_aggregate_is_an_empty_map_not_none() -> None:
    # The router reads it with `.get`; an explicit empty map keeps that read
    # honest for a client that sends nothing.
    graph = _GraphRecordingState()
    await _events(graph)
    assert graph.state["client_attributes"] == {}


async def test_what_done_ships_is_what_the_next_turn_reads_back() -> None:
    """The round trip, both ways the client can send it back. A shape mismatch
    between the two halves would silently drop the switch on the very next
    turn."""
    done = [e for e in await _events(_GraphThatSettles()) if e.type == "done"][0]
    shipped = done.data["attributes"]

    # (a) persisted on the assistant message and replayed in `messages`
    replayed = [
        {"role": "user", "content": "отвечай по-русски"},
        {"role": "assistant", "content": "Ответ.", "attributes": shipped},
    ]
    from_messages = remembered_attributes(replayed)
    assert from_messages[REPLY_LANGUAGE].value == "ru"
    assert from_messages[REPLY_LANGUAGE].explicit

    # (b) folded into the aggregate and sent as request metadata
    from_aggregate = remembered_attributes(None, shipped)
    assert from_aggregate[REPLY_LANGUAGE].value == "ru"
