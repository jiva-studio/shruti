"""Tests for `build_llm_provider` — the LLM_PROVIDER → adapter dispatch.

Single-provider deployment: only `openrouter` is accepted. Pydantic's
Literal on `Settings.llm_provider` rejects anything else at construction.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from shruti_chat.config import Settings
from shruti_chat.infra.llm_provider import (
    OpenRouterLLMProvider,
    build_llm_provider,
)


def _settings(**overrides: Any) -> Settings:
    return Settings(**{"indexer_bootstrap_on_start": False, **overrides})


def test_openrouter_branch() -> None:
    s = _settings(
        llm_provider="openrouter",
        openrouter_api_key="sk-test",
    )
    provider = build_llm_provider(s)
    assert isinstance(provider, OpenRouterLLMProvider)


def test_unknown_provider_rejected_at_settings_construction() -> None:
    """The Literal on Settings.llm_provider catches typos before they
    reach `build_llm_provider` — pydantic raises ValidationError."""
    with pytest.raises(ValidationError):
        _settings(llm_provider="bogus")  # type: ignore[arg-type]


def test_legacy_yandex_provider_rejected() -> None:
    """Yandex was dropped in #728; the Literal must refuse it."""
    with pytest.raises(ValidationError):
        _settings(llm_provider="yandex")  # type: ignore[arg-type]


def test_legacy_gigachat_provider_rejected() -> None:
    """GigaChat was dropped in #728; the Literal must refuse it."""
    with pytest.raises(ValidationError):
        _settings(llm_provider="gigachat")  # type: ignore[arg-type]


def test_openrouter_branch_fails_without_key_at_adapter_construction() -> None:
    """OpenRouter's missing-key check lives in the adapter constructor,
    not the Settings validator — that pattern predates this PR and is
    preserved so existing tests that build `Settings(...)` without an
    `openrouter_api_key` keep working."""
    s = _settings(llm_provider="openrouter", openrouter_api_key=None)
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        build_llm_provider(s)
