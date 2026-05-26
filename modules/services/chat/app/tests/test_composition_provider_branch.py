"""Tests for `main.build_llm_provider` — the LLM_PROVIDER → adapter dispatch.

Asserts each branch instantiates the matching adapter class and that
the settings-level validator already rejected the bogus case so
`build_llm_provider` never sees an unknown value at runtime.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from lectorium_chat.config import Settings
from lectorium_chat.infra.llm_provider import (
    GigaChatLLMProvider,
    OpenRouterLLMProvider,
    YandexLLMProvider,
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


def test_yandex_branch() -> None:
    s = _settings(
        llm_provider="yandex",
        yandex_gpt_folder_id="folder-x",
        yandex_gpt_api_key="key-x",
    )
    provider = build_llm_provider(s)
    assert isinstance(provider, YandexLLMProvider)


def test_yandex_branch_with_iam_token() -> None:
    s = _settings(
        llm_provider="yandex",
        yandex_gpt_folder_id="folder-x",
        yandex_iam_token="t1.test",
    )
    provider = build_llm_provider(s)
    assert isinstance(provider, YandexLLMProvider)


def test_gigachat_branch() -> None:
    s = _settings(
        llm_provider="gigachat",
        gigachat_client_id="id-x",
        gigachat_client_secret="secret-x",
    )
    provider = build_llm_provider(s)
    assert isinstance(provider, GigaChatLLMProvider)


def test_unknown_provider_rejected_at_settings_construction() -> None:
    """The Literal on Settings.llm_provider catches typos before they
    reach `build_llm_provider` — pydantic raises ValidationError."""
    with pytest.raises(ValidationError):
        _settings(llm_provider="bogus")  # type: ignore[arg-type]


def test_yandex_branch_fails_without_folder() -> None:
    """Settings.model_validator rejects yandex without folder id."""
    with pytest.raises(ValidationError, match="YANDEX_GPT_FOLDER_ID"):
        _settings(llm_provider="yandex", yandex_gpt_api_key="key")


def test_yandex_branch_fails_without_credentials() -> None:
    with pytest.raises(ValidationError, match="API_KEY or"):
        _settings(llm_provider="yandex", yandex_gpt_folder_id="folder")


def test_gigachat_branch_fails_without_secret() -> None:
    with pytest.raises(ValidationError, match="GIGACHAT_CLIENT"):
        _settings(llm_provider="gigachat", gigachat_client_id="id-only")


def test_openrouter_branch_fails_without_key_at_adapter_construction() -> None:
    """OpenRouter's missing-key check lives in the adapter constructor,
    not the Settings validator — that pattern predates this PR and is
    preserved so existing tests that build `Settings(...)` without an
    `openrouter_api_key` keep working."""
    s = _settings(llm_provider="openrouter", openrouter_api_key=None)
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        build_llm_provider(s)
