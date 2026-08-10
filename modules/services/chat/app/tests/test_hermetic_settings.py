"""The suite must read the SHIPPED configuration, not the developer's.

`litellm` calls `load_dotenv()` on import, which used to copy the service
`.env` into `os.environ` for every local run — env vars beat model defaults, so
`Settings()` under test answered with dev values (`ip_rate_limit_per_day` 200
against a shipped 2000, a gemini `llm_default` against the shipped deepseek
one). Two rate-limit tests had already been bitten: they loop 200 admissions,
and they passed or failed purely by import order.

These are the guards on the counter-measures in `conftest.py`. They fail loudly
the moment the environment gets a vote again.
"""

from __future__ import annotations

import os

import pytest
from pydantic_core import PydanticUndefined

from lectorium_chat.config import Settings

# The numbers the service actually ships with. Spelled out rather than read
# from `model_fields`, so that a silent edit to a cap has to be an explicit one.
SHIPPED = {
    "ip_rate_limit_per_day": 2000,
    "chat_anon_per_day": 3,
    "chat_free_per_day": 10,
    "chat_pro_per_day": 200,
    "llm_default": "openrouter/deepseek/deepseek-chat",
    "llm_fallback": "openrouter/anthropic/claude-haiku-4.5",
}


@pytest.mark.parametrize(("field", "expected"), sorted(SHIPPED.items()))
def test_settings_read_shipped_values(field: str, expected: object) -> None:
    assert getattr(Settings(), field) == expected


def test_every_field_is_its_declared_default() -> None:
    """Nothing at all comes from the environment — not just the caps above."""
    from conftest import SUITE_ENV_OVERRIDES  # the root conftest, on sys.path

    settings = Settings()
    drifted = {
        name: (getattr(settings, name), field.default)
        for name, field in Settings.model_fields.items()
        if field.default is not PydanticUndefined
        and name.upper() not in SUITE_ENV_OVERRIDES
        and getattr(settings, name) != field.default
    }
    assert drifted == {}


def test_no_settings_name_survives_in_the_environment() -> None:
    from conftest import SUITE_ENV_OVERRIDES, _settings_env_names

    leaked = _settings_env_names() - SUITE_ENV_OVERRIDES
    assert sorted(name for name in leaked if name in os.environ) == []


def test_load_dotenv_cannot_inject_mid_session() -> None:
    """The leak happens at import time, and imports are not ours to order."""
    import dotenv

    before = dict(os.environ)
    assert dotenv.load_dotenv() is False
    assert dict(os.environ) == before
