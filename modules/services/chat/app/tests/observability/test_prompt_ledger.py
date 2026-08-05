"""A trace must record which prompt versions produced it.

A hosted Langfuse prompt overrides the bundled `.md` and edits reach every pod
within the 60s cache TTL. That is the point of prompt management and is left
alone here — but it meant a trace could not be tied to the prompts that
produced it. When `marker_validity` drops, the question is "what changed", and
the answer was unavailable.

The ledger is a mutable dict in a ContextVar rather than a value replaced with
`set()`: `create_task` copies the context MAPPING, so a `set()` in a child task
never reaches the parent, while mutations of a shared dict do. Every prompt
fetch happens in the turn's task or one spawned from it, so one dict installed
at turn entry collects them all.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from lectorium_chat.observability import langfuse_client as lc


class _StubPrompt:
    def __init__(self, version: int) -> None:
        self.version = version
        self.labels = ["production"]
        self.config = {}

    def compile(self) -> str:
        return "prompt body"


class _StubLangfuse:
    def __init__(self) -> None:
        self.trace_updates: list[dict[str, Any]] = []
        self.versions: dict[str, int] = {}

    def get_prompt(self, name: str, **kw: Any) -> _StubPrompt:
        return _StubPrompt(self.versions.get(name, 1))

    def update_current_trace(self, **kwargs: Any) -> None:
        self.trace_updates.append(kwargs)

    def start_as_current_span(self, **kwargs: Any):
        class _Span:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False

        return _Span()


@pytest.fixture
def stub(monkeypatch: pytest.MonkeyPatch) -> _StubLangfuse:
    client = _StubLangfuse()
    monkeypatch.setattr(lc, "_LANGFUSE", client)
    monkeypatch.setattr(lc, "_force_fallback", lambda: False)
    return client


def _fetch(name: str) -> Any:
    return lc.prompt_with_fallback(name, fallback="disk copy")


async def test_versions_reach_the_trace(stub: _StubLangfuse) -> None:
    stub.versions = {"chat-router": 7, "query-planner": 3}

    async with lc.with_langfuse_trace("t" * 32, "u", None):
        _fetch("chat-router")
        _fetch("query-planner")

    flushed = [u for u in stub.trace_updates if "prompts" in (u.get("metadata") or {})]
    assert flushed, "the ledger never reached the trace"
    assert flushed[-1]["metadata"]["prompts"] == {"chat-router": 7, "query-planner": 3}


async def test_a_fetch_from_a_child_task_is_captured(stub: _StubLangfuse) -> None:
    """Pipeline stages and graph nodes run in spawned tasks — the whole reason
    the ledger is a shared mutable dict."""
    stub.versions = {"synthesis-planner": 11}

    async with lc.with_langfuse_trace("t" * 32, "u", None):
        await asyncio.create_task(asyncio.to_thread(_fetch, "synthesis-planner"))

    flushed = [u for u in stub.trace_updates if "prompts" in (u.get("metadata") or {})]
    assert flushed[-1]["metadata"]["prompts"] == {"synthesis-planner": 11}


async def test_concurrent_turns_keep_separate_ledgers(stub: _StubLangfuse) -> None:
    stub.versions = {"a": 1, "b": 2}

    async def turn(name: str) -> None:
        async with lc.with_langfuse_trace("t" * 32, "u", None):
            _fetch(name)
            await asyncio.sleep(0)

    await asyncio.gather(turn("a"), turn("b"))

    maps = [
        u["metadata"]["prompts"]
        for u in stub.trace_updates
        if "prompts" in (u.get("metadata") or {})
    ]
    assert {"a": 1} in maps and {"b": 2} in maps
    assert all(len(m) == 1 for m in maps), f"ledgers bled across turns: {maps}"


async def test_first_write_wins(stub: _StubLangfuse) -> None:
    """A long turn can straddle a publish; "what this turn started with" is
    the deterministic answer."""
    stub.versions = {"chat-router": 4}

    async with lc.with_langfuse_trace("t" * 32, "u", None):
        _fetch("chat-router")
        stub.versions["chat-router"] = 5
        _fetch("chat-router")

    flushed = [u for u in stub.trace_updates if "prompts" in (u.get("metadata") or {})]
    assert flushed[-1]["metadata"]["prompts"] == {"chat-router": 4}


async def test_fallback_is_recorded_as_a_null_version(
    monkeypatch: pytest.MonkeyPatch, stub: _StubLangfuse,
) -> None:
    """`version is None` IS the "served from the bundled .md" marker — one
    field carries both facts."""
    monkeypatch.setattr(lc, "_force_fallback", lambda: True)

    async with lc.with_langfuse_trace("t" * 32, "u", None):
        _fetch("chat-router")

    flushed = [u for u in stub.trace_updates if "prompts" in (u.get("metadata") or {})]
    assert flushed[-1]["metadata"]["prompts"] == {"chat-router": None}
    assert flushed[-1]["metadata"]["prompts_fallback"] == ["chat-router"]


async def test_langfuse_off_records_nothing_to_a_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No client, no trace write — but the ledger still collects, so the
    structlog line reports the all-fallback turn."""
    monkeypatch.setattr(lc, "_LANGFUSE", None)

    async with lc.with_langfuse_trace("t" * 32, "u", None):
        _fetch("chat-router")
        assert lc.current_prompt_ledger() == {"chat-router": None}


async def test_a_turn_with_no_prompts_writes_no_metadata(stub: _StubLangfuse) -> None:
    """A trailing `update_current_trace` would clobber what the caller last
    set — several trace tests assert on the FINAL update call."""
    async with lc.with_langfuse_trace("t" * 32, "u", None):
        pass

    assert not [
        u for u in stub.trace_updates if "prompts" in (u.get("metadata") or {})
    ]


async def test_the_ledger_is_cleared_after_the_turn(stub: _StubLangfuse) -> None:
    async with lc.with_langfuse_trace("t" * 32, "u", None):
        _fetch("chat-router")

    assert lc.current_prompt_ledger() is None


async def test_caller_exception_is_not_masked(stub: _StubLangfuse) -> None:
    """Pre-existing latent bug: the caller's body sat inside the same `try` as
    the span open, so an escaping exception was thrown back in at the `yield`
    and hit `except Exception: ... yield None` — yielding during a throw raises
    `RuntimeError: generator didn't stop after throw()` and buries the real
    error."""
    with pytest.raises(ValueError, match="the real error"):
        async with lc.with_langfuse_trace("t" * 32, "u", None):
            raise ValueError("the real error")
