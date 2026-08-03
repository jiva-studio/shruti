"""The settled language leaves the turn on `done`, not as its own event.

That is what closes the loop: the client persists it on the assistant message
and replays it, so a language the user asked for survives past the 20-message
history window and an app restart. If it stayed inside the turn, the switch
would die the moment the request scrolled out of the window.

Same shape as `aliases`, which already rides out this way.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

from lectorium_chat.application import chat_turn
from lectorium_chat.application.chat_turn import run_chat_turn
from lectorium_chat.application.reply_language import remembered_reply_language


class _GraphThatSettlesLanguage:
    """Stands in for the graph: the router node emits the custom event after
    resolving the language, then the answer streams."""

    async def astream(self, _state, *, context, stream_mode):  # noqa: ARG002
        yield ("custom", {"type": "reply_language", "data": {
            "lang": "ru", "name": "Русский", "requested": True,
        }})
        yield ("custom", {"type": "delta", "data": {"text": "Ответ."}})


class _GraphThatSettlesNothing:
    async def astream(self, _state, *, context, stream_mode):  # noqa: ARG002
        yield ("custom", {"type": "delta", "data": {"text": "Answer."}})


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


async def _events(graph: Any) -> list[Any]:
    deps = _FakeDeps(
        settings=_FakeSettings(), chat_graph=graph, llm=MagicMock(),
        catalog_repo=MagicMock(),
    )
    with patch.object(chat_turn, "get_langfuse", return_value=None), \
         patch.object(chat_turn, "with_langfuse_trace", _no_trace):
        return [
            ev async for ev in run_chat_turn(
                history=[{"role": "user", "content": "отвечай по-русски"}],
                lang="en",
                request_id="r-lang-1",
                deps=deps,
            )
        ]


async def test_done_carries_the_settled_language() -> None:
    events = await _events(_GraphThatSettlesLanguage())

    done = [e for e in events if e.type == "done"]
    assert len(done) == 1
    assert done[0].data["reply_language"] == {
        "lang": "ru", "name": "Русский", "requested": True,
    }


async def test_the_language_is_not_a_client_facing_event() -> None:
    # It is per-message server state, not something to render mid-stream.
    events = await _events(_GraphThatSettlesLanguage())
    assert [e.type for e in events] == ["delta", "done"]


async def test_done_omits_the_language_when_nothing_was_settled() -> None:
    # Absent, not null: the client keeps whatever it stored before, and the
    # app locale stays in force.
    events = await _events(_GraphThatSettlesNothing())
    done = [e for e in events if e.type == "done"][0]
    assert "reply_language" not in done.data


async def test_what_done_ships_is_what_the_next_turn_reads_back() -> None:
    """The round trip, end to end: whatever leaves on `done` must be readable
    by `remembered_reply_language` when the client replays it on the assistant
    message. A shape mismatch between the two halves would silently drop the
    switch on the very next turn."""
    done = [e for e in await _events(_GraphThatSettlesLanguage()) if e.type == "done"][0]

    replayed = [
        {"role": "user", "content": "отвечай по-русски"},
        {"role": "assistant", "content": "Ответ.",
         "reply_language": done.data["reply_language"]},
    ]

    remembered = remembered_reply_language(replayed)
    assert remembered is not None
    assert remembered.lang == "ru" and remembered.requested
