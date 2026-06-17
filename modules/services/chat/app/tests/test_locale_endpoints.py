"""`/questions` and `/title` must accept ANY UI locale, not just ru/en.

Before the fix both DTOs declared `lang: Literal["ru","en"]`, so a uk / sr /
hi client sending its UI locale got a 422 — and the handlers' own
`_SYSTEM.get(lang, _SYSTEM["en"])` English fallback was dead code. The fix
relaxes both to `lang: str`, letting the English-prompt fallback serve any
locale (200, not 422).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from shruti_chat.api import questions as questions_mod
from shruti_chat.api import title as title_mod
from shruti_chat.api._auth import get_current_user
from shruti_chat.application.rate_limiter import RateLimitResult
from shruti_chat.composition import get_deps
from shruti_chat.infra.auth.jwt_verifier import VerifiedUser


pytestmark = pytest.mark.asyncio


@dataclass
class _RateLimiter:
    async def check_and_increment(self, *a, **k) -> RateLimitResult:
        return RateLimitResult(allowed=True)


@dataclass
class _Deps:
    rate_limiter: Any
    kv_cache: Any = None


def _build_app(monkeypatch) -> FastAPI:
    app = FastAPI()
    app.include_router(questions_mod.router)
    app.include_router(title_mod.router)

    fake_user = VerifiedUser(id="u1", anonymous=False)
    fake_deps = _Deps(rate_limiter=_RateLimiter())
    app.dependency_overrides[get_current_user] = lambda: fake_user
    app.dependency_overrides[get_deps] = lambda: fake_deps

    # Stub the LLM so no network call is made.
    async def _fake_oneshot(**_kw) -> str:
        return "Why does this matter?\nWhat is the deeper meaning?"

    monkeypatch.setattr(questions_mod, "run_oneshot", _fake_oneshot)

    class _Msg:
        content = "Karma and free will"

    class _Choice:
        message = _Msg()

    class _Resp:
        choices = [_Choice()]

    async def _fake_acompletion(**_kw):
        return _Resp()

    monkeypatch.setattr(title_mod.llm, "acompletion", _fake_acompletion)
    return app


async def _client(app: FastAPI) -> AsyncClient:
    return AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    )


async def test_questions_accepts_non_ru_en_locale(monkeypatch) -> None:
    app = _build_app(monkeypatch)
    async with await _client(app) as ac:
        r = await ac.post("/questions", json={
            "focus": {
                "trackId": "t1", "startMs": 0, "endMs": 1000,
                "text": "Some lecture fragment text.",
            },
            "lang": "uk",  # non ru/en — used to 422
        })
    assert r.status_code == 200, r.text
    assert r.json()["questions"]  # English-fallback prompt produced chips


async def test_title_accepts_non_ru_en_locale(monkeypatch) -> None:
    app = _build_app(monkeypatch)
    async with await _client(app) as ac:
        r = await ac.post("/title", json={
            "messages": [{"role": "user", "content": "What is karma?"}],
            "lang": "uk",
        })
    assert r.status_code == 200, r.text
    assert r.json()["title"]


async def test_questions_still_accepts_ru(monkeypatch) -> None:
    app = _build_app(monkeypatch)
    async with await _client(app) as ac:
        r = await ac.post("/questions", json={
            "focus": {
                "trackId": "t1", "startMs": 0, "endMs": 1000,
                "text": "Фрагмент лекции.",
            },
            "lang": "ru",
        })
    assert r.status_code == 200, r.text


async def test_request_dtos_accept_arbitrary_lang() -> None:
    # DTO-level guard: no `Literal` constraint left that would 422.
    q = questions_mod.QuestionsRequest(
        focus={"trackId": "t", "startMs": 0, "endMs": 1, "text": "x"},
        lang="sr-Cyrl",
    )
    assert q.lang == "sr-Cyrl"
    t = title_mod.TitleRequest(
        messages=[{"role": "user", "content": "hi"}], lang="hi",
    )
    assert t.lang == "hi"
    # Defaults flip to "en" (was "ru").
    assert questions_mod.QuestionsRequest(
        focus={"trackId": "t", "startMs": 0, "endMs": 1, "text": "x"},
    ).lang == "en"
    assert title_mod.TitleRequest(
        messages=[{"role": "user", "content": "hi"}],
    ).lang == "en"
