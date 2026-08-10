"""`/chat/feedback` drops free-text comments when region=="ru" (#728).

Boolean + categorical scores still ship — those carry no user-authored
prose. The free-text body is the one PII surface; it must never cross
the trust boundary for RU-originated traffic.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from shruti_chat.api import feedback as feedback_module
from shruti_chat.api.feedback import (
    FeedbackCategory,
    FeedbackIn,
    FeedbackValue,
    post_feedback,
)
from shruti_chat.application.rate_limiter import RateLimitResult


class _RecordingLangfuse:
    def __init__(self) -> None:
        self.scores: list[dict[str, Any]] = []

    def create_score(self, **kwargs: Any) -> None:
        self.scores.append(kwargs)


class _AlwaysAllowLimiter:
    async def check_and_increment(
        self, *args: Any, **kwargs: Any
    ) -> RateLimitResult:
        return RateLimitResult(allowed=True)


def _request_with_region_header(region: str | None, *, client_host: str) -> Any:
    from fastapi import Request

    headers: list[tuple[bytes, bytes]] = []
    if region is not None:
        headers.append((b"x-shruti-region", region.encode()))
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/chat/feedback",
        "headers": headers,
        "client": (client_host, 0),
    }
    return Request(scope)


def _user() -> Any:
    return SimpleNamespace(
        id="user-1",
        anonymous=False,
        tier="free",
        quota_id="",
        tier_expires_at=0,
    )


class _FakeTurnStore:
    """Only the read the feedback route makes. `owner=None` mimics both a
    trace id no turn ever used and a Redis error — the adapter collapses
    them into the same `None`."""

    def __init__(self, owner: str | None = "user-1") -> None:
        self.owner = owner
        self.seen: list[str] = []

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        self.seen.append(trace_id)
        if self.owner is None:
            return None
        return {"state": "done", "user_id": self.owner, "events": []}


def _deps(turn_store: _FakeTurnStore | None = None) -> Any:
    return SimpleNamespace(
        rate_limiter=_AlwaysAllowLimiter(),
        turn_store=turn_store or _FakeTurnStore(),
    )


@pytest.fixture
def fake_langfuse(monkeypatch: pytest.MonkeyPatch) -> _RecordingLangfuse:
    fake = _RecordingLangfuse()
    monkeypatch.setattr(feedback_module, "get_langfuse", lambda: fake)
    return fake


@pytest.mark.asyncio
async def test_ru_region_drops_user_feedback_text_score(
    fake_langfuse: _RecordingLangfuse,
) -> None:
    request = _request_with_region_header("ru", client_host="10.0.0.5")
    payload = FeedbackIn(
        trace_id="trace-abc",
        value=FeedbackValue.DOWN,
        category=FeedbackCategory.OFF_TOPIC,
        comment="some private feedback prose",
    )
    await post_feedback(
        request=request,
        payload=payload,
        user=_user(),
        deps=_deps(),
    )
    names = [s["name"] for s in fake_langfuse.scores]
    assert "user_feedback" in names
    assert "user_feedback_category" in names
    assert "user_feedback_text" not in names, (
        "RU region must NOT persist free-text feedback to Langfuse"
    )


@pytest.mark.asyncio
async def test_non_ru_region_keeps_user_feedback_text_score(
    fake_langfuse: _RecordingLangfuse,
) -> None:
    request = _request_with_region_header(None, client_host="10.0.0.5")
    payload = FeedbackIn(
        trace_id="trace-xyz",
        value=FeedbackValue.DOWN,
        category=FeedbackCategory.OFF_TOPIC,
        comment="some prose from EU",
    )
    await post_feedback(
        request=request,
        payload=payload,
        user=_user(),
        deps=_deps(),
    )
    names = [s["name"] for s in fake_langfuse.scores]
    assert "user_feedback_text" in names


@pytest.mark.asyncio
async def test_ru_header_from_untrusted_source_treated_as_global(
    fake_langfuse: _RecordingLangfuse,
) -> None:
    """An attacker injecting the header from a public IP must not be able
    to suppress logging — region resolves to None and the text score ships."""
    request = _request_with_region_header("ru", client_host="8.8.8.8")
    payload = FeedbackIn(
        trace_id="trace-spoof",
        value=FeedbackValue.DOWN,
        category=FeedbackCategory.OTHER,
        comment="injected from public source",
    )
    await post_feedback(
        request=request,
        payload=payload,
        user=_user(),
        deps=_deps(),
    )
    names = [s["name"] for s in fake_langfuse.scores]
    assert "user_feedback_text" in names
