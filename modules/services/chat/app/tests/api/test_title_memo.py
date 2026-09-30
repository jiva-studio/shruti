"""`/title` memoises a title for 30 days; a failed LLM call is not a title."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from shruti_chat.api import title as title_mod
from shruti_chat.api._auth import get_current_user
from shruti_chat.application.cache_versions import CacheVersionRegistry
from shruti_chat.application.memo_cache import KVMemoCache
from shruti_chat.application.rate_limiter import RateLimitResult
from shruti_chat.composition import get_deps
from shruti_chat.config import get_settings
from shruti_chat.infra.auth.jwt_verifier import VerifiedUser
from shruti_chat.infra.cache.memory_kv_cache import MemoryKVCache

pytestmark = pytest.mark.asyncio


class _RateLimiter:
    async def check_and_increment(self, *a: Any, **k: Any) -> RateLimitResult:
        return RateLimitResult(allowed=True)


@dataclass
class _Deps:
    rate_limiter: Any = field(default_factory=_RateLimiter)
    memo_cache: Any = field(
        default_factory=lambda: KVMemoCache(MemoryKVCache(max_entries=8), CacheVersionRegistry()),
    )
    settings: Any = field(default_factory=get_settings)


class _Msg:
    content = "Karma and free will"


class _Choice:
    message = _Msg()


class _Resp:
    choices = [_Choice()]


async def test_a_failed_title_is_not_remembered(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    async def _down_then_up(**_kw: Any) -> _Resp:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TimeoutError("provider timeout")
        return _Resp()

    monkeypatch.setattr(title_mod.llm, "acompletion", _down_then_up)
    app = FastAPI()
    app.include_router(title_mod.router)
    deps = _Deps()
    app.dependency_overrides[get_current_user] = lambda: VerifiedUser(id="u1", anonymous=False)
    app.dependency_overrides[get_deps] = lambda: deps
    body = {"messages": [{"role": "user", "content": "What is karma?"}], "lang": "en"}

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as ac:
        first = await ac.post("/title", json=body)
        second = await ac.post("/title", json=body)
        third = await ac.post("/title", json=body)

    assert first.status_code == 200, first.text
    assert first.json() == {"title": None}
    assert second.json()["title"] == "Karma and free will"
    assert third.json()["title"] == "Karma and free will"
    assert calls == 2
