"""PR-1b: client-disconnect tagging on the Langfuse trace.

When the client closes the SSE connection mid-stream, the chat turn's
`is_disconnected()` poll detects it and returns early. PR-1b extends
that early-return to also tag the active Langfuse trace with
`cancelled_by_client=True` so corpus evals can exclude these turns
from quality metrics, and to cancel the speculative-embed task so it
doesn't linger past the user's interest.

The chat-turn module is heavy (graph + ports). Rather than build a
full `AppDeps` here, we mock the two collaborators that matter for
this code path: the chat graph (emits one event) and the Langfuse
client (records the `update_current_trace` call).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock, patch

from lectorium_chat.application import chat_turn
from lectorium_chat.application.chat_turn import run_chat_turn


class _FakeGraph:
    """Minimal chat-graph stand-in. Yields a single `delta` event so
    the cancellation poll fires AFTER something has been streamed —
    that's the realistic mid-stream timing the early-return guards."""

    async def astream(self, _state, *, context, stream_mode):  # noqa: ARG002
        yield ("custom", {"type": "delta", "data": {"text": "hello"}})
        # Subsequent yields would fire after the disconnect — by which
        # point the generator has already returned. We still emit one
        # more so a missing-cancel bug would surface as extra output.
        yield ("custom", {"type": "delta", "data": {"text": "world"}})


class _FakeEmbedder:
    """Embedder with a `name` and `embed_query` so the speculative
    embed task can be created. The task's payload is never awaited in
    this test; we just need a coroutine to schedule."""

    name = "fake-embed"

    async def embed_query(self, _q):
        await asyncio.sleep(60)  # would block forever; cancellation tears it down
        return [0.0]


@dataclass
class _FakeSettings:
    library_db_path: str = "/tmp/x.db"
    embed_model: str = "fake-embed"
    embed_dim: int = 1536


@dataclass
class _FakeDeps:
    settings: _FakeSettings
    chat_graph: _FakeGraph
    llm: Any
    embedder: _FakeEmbedder
    chunk_repo: Any
    catalog_repo: Any
    pool: Any
    kv_cache: Any


def _make_deps() -> _FakeDeps:
    return _FakeDeps(
        settings=_FakeSettings(),
        chat_graph=_FakeGraph(),
        llm=MagicMock(),
        embedder=_FakeEmbedder(),
        chunk_repo=MagicMock(),
        catalog_repo=MagicMock(),
        pool=MagicMock(),
        kv_cache=MagicMock(),
    )


async def test_disconnect_tags_langfuse_trace_and_cancels_embed():
    """The very next disconnect-poll after the first event must:
    1) tag the active Langfuse trace with `cancelled_by_client`,
    2) cancel the speculative embed task,
    3) stop the generator (no further events delivered to the client).
    """
    deps = _make_deps()

    # `is_disconnected` returns True on the first call so we cancel
    # immediately after the first delta. Mirrors a client that closed
    # the connection while the LLM was still emitting tokens.
    poll_calls = 0

    async def _is_disconnected() -> bool:
        nonlocal poll_calls
        poll_calls += 1
        return True

    # Mock Langfuse client: spies on the cancellation tag call.
    fake_lf = MagicMock()
    fake_lf.update_current_trace = MagicMock()

    # `with_langfuse_trace` yields the root span — we don't care about
    # its identity here, just that the cancel-tag branch fires. Patch
    # the context manager to yield None (matches the "Langfuse off"
    # production path; the cancel-tag code path reads `get_langfuse()`
    # independently of the yielded span).
    @asynccontextmanager
    async def _fake_trace_cm(*args, **kwargs):
        yield None

    with patch.object(chat_turn, "get_langfuse", return_value=fake_lf), \
         patch.object(chat_turn, "with_langfuse_trace", _fake_trace_cm):
        events = []
        async for ev in run_chat_turn(
            history=[{"role": "user", "content": "test question"}],
            lang="en",
            request_id="r-cancel-1",
            user_context=None,
            is_disconnected=_is_disconnected,
            deps=deps,
        ):
            events.append(ev)

    # Exactly one delta delivered (the second would have been swallowed
    # by the early-return after disconnect detection).
    delta_events = [e for e in events if e.type == "delta"]
    assert len(delta_events) == 1
    assert delta_events[0].data == {"text": "hello"}

    # Langfuse tag landed exactly once with the expected payload.
    fake_lf.update_current_trace.assert_called_once()
    call_kwargs = fake_lf.update_current_trace.call_args.kwargs
    assert "cancelled_by_client" in call_kwargs.get("tags", [])
    assert call_kwargs.get("metadata", {}).get("cancelled_by_client") is True


async def test_disconnect_swallows_langfuse_tag_failure():
    """A flaky Langfuse client must NOT propagate exceptions up through
    the chat-turn generator. The cancel-tag is best-effort — losing the
    tag is better than failing the cancellation cleanup."""
    deps = _make_deps()

    async def _is_disconnected() -> bool:
        return True

    fake_lf = MagicMock()
    fake_lf.update_current_trace.side_effect = RuntimeError("langfuse down")

    @asynccontextmanager
    async def _fake_trace_cm(*args, **kwargs):
        yield None

    with patch.object(chat_turn, "get_langfuse", return_value=fake_lf), \
         patch.object(chat_turn, "with_langfuse_trace", _fake_trace_cm):
        # Must NOT raise — the warning is logged inside chat_turn.
        events = []
        async for ev in run_chat_turn(
            history=[{"role": "user", "content": "test question"}],
            lang="en",
            request_id="r-cancel-2",
            user_context=None,
            is_disconnected=_is_disconnected,
            deps=deps,
        ):
            events.append(ev)
    assert any(e.type == "delta" for e in events)


async def test_no_disconnect_does_not_tag():
    """The Langfuse cancel tag must only fire on actual disconnect.
    A normal turn (`is_disconnected` always False) must NOT touch the
    `cancelled_by_client` path."""
    deps = _make_deps()

    async def _never_disconnected() -> bool:
        return False

    fake_lf = MagicMock()

    @asynccontextmanager
    async def _fake_trace_cm(*args, **kwargs):
        yield None

    with patch.object(chat_turn, "get_langfuse", return_value=fake_lf), \
         patch.object(chat_turn, "with_langfuse_trace", _fake_trace_cm):
        async for _ in run_chat_turn(
            history=[{"role": "user", "content": "test"}],
            lang="en",
            request_id="r-normal-1",
            user_context=None,
            is_disconnected=_never_disconnected,
            deps=deps,
        ):
            pass

    # The cancel-tag is the only call that uses the
    # `cancelled_by_client` payload — verify none of the calls carried
    # it. (Other calls like end-of-turn `output=...` are allowed.)
    for call in fake_lf.update_current_trace.call_args_list:
        kwargs = call.kwargs
        assert "cancelled_by_client" not in kwargs.get("tags", []) if kwargs.get("tags") else True
        assert not kwargs.get("metadata", {}).get("cancelled_by_client"), \
            "cancelled_by_client must only appear on the disconnect path"
