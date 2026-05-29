"""Langfuse trace metadata carries `region` always; `user_id` is hashed
when `region=="ru"` (#728)."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest

from lectorium_chat.observability import langfuse_client as lc


class _FakeSpan:
    def __enter__(self) -> "_FakeSpan":
        return self

    def __exit__(self, *exc) -> None:
        return None


class _FakeLangfuse:
    """Records the calls `with_langfuse_trace` makes so tests can inspect."""

    def __init__(self) -> None:
        self.update_calls: list[dict[str, Any]] = []

    @contextmanager
    def start_as_current_span(self, **kwargs: Any):
        yield _FakeSpan()

    def update_current_trace(self, **kwargs: Any) -> None:
        self.update_calls.append(kwargs)


@pytest.fixture
def fake_langfuse(monkeypatch: pytest.MonkeyPatch) -> _FakeLangfuse:
    fake = _FakeLangfuse()
    monkeypatch.setattr(lc, "_LANGFUSE", fake)
    return fake


async def _drive_trace(region: str | None) -> None:
    async with lc.with_langfuse_trace(
        "abc123",
        "user-uuid",
        session_id="sess-1",
        region=region,
    ):
        pass


@pytest.mark.asyncio
async def test_trace_metadata_carries_region_for_global(
    fake_langfuse: _FakeLangfuse,
) -> None:
    await _drive_trace(region=None)
    assert fake_langfuse.update_calls, "update_current_trace must run"
    call = fake_langfuse.update_calls[-1]
    assert call["metadata"] == {"region": None}
    assert call["user_id"] == "user-uuid"


@pytest.mark.asyncio
async def test_trace_metadata_carries_region_ru(
    fake_langfuse: _FakeLangfuse,
) -> None:
    await _drive_trace(region="ru")
    call = fake_langfuse.update_calls[-1]
    assert call["metadata"]["region"] == "ru"


@pytest.mark.asyncio
async def test_user_id_hashed_when_region_ru_and_salt_set(
    fake_langfuse: _FakeLangfuse, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Force a fresh Settings load with the salt populated.
    from lectorium_chat import config as cfg

    monkeypatch.setenv("LANGFUSE_PII_SALT", "test-salt")
    monkeypatch.setattr(cfg, "_settings", None)
    try:
        await _drive_trace(region="ru")
    finally:
        monkeypatch.setattr(cfg, "_settings", None)
    call = fake_langfuse.update_calls[-1]
    user_id = call["user_id"]
    assert user_id is not None
    assert user_id != "user-uuid"
    # 16-char truncated sha256 hex
    assert len(user_id) == 16
    assert all(c in "0123456789abcdef" for c in user_id)


@pytest.mark.asyncio
async def test_user_id_dropped_when_region_ru_but_salt_unset(
    fake_langfuse: _FakeLangfuse, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without a salt, drop the user_id entirely rather than ship raw PII.

    The startup `warn_if_pii_salt_unset` shouts about this in prod logs
    so an unset salt doesn't go unnoticed; this test pins the runtime
    behaviour either way — RU traces never carry raw user ids.
    """
    from lectorium_chat import config as cfg

    monkeypatch.delenv("LANGFUSE_PII_SALT", raising=False)
    monkeypatch.setattr(cfg, "_settings", None)
    try:
        await _drive_trace(region="ru")
    finally:
        monkeypatch.setattr(cfg, "_settings", None)
    call = fake_langfuse.update_calls[-1]
    assert call["user_id"] is None


@pytest.mark.asyncio
async def test_user_id_not_hashed_for_non_ru_region(
    fake_langfuse: _FakeLangfuse, monkeypatch: pytest.MonkeyPatch
) -> None:
    from lectorium_chat import config as cfg

    monkeypatch.setenv("LANGFUSE_PII_SALT", "test-salt")
    monkeypatch.setattr(cfg, "_settings", None)
    try:
        await _drive_trace(region=None)
    finally:
        monkeypatch.setattr(cfg, "_settings", None)
    call = fake_langfuse.update_calls[-1]
    assert call["user_id"] == "user-uuid"
