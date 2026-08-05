"""No setting may be undiscoverable.

`.env.example` documented 29 of 105 settings. Among the missing were
`REDIS_URL` — which `main.py` refuses to boot without — and `ENV` and
`CORS_ALLOW_ORIGINS`, the two inputs to the production safety guard. Nothing
stopped the gap growing, and it grew every time a setting was added.

This replaces the fixed list in `test_load_knobs_documented.py` with the whole
model. That list stays as the narrower statement about which knobs are
*intended* to be operator-facing; this one just says everything is findable.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check_env_example.py"


@pytest.mark.skipif(not _SCRIPT.exists(), reason="checkout layout")
def test_every_setting_appears_in_env_example() -> None:
    """Run the checker as a subprocess — it is the same entry point a
    developer runs, so the test cannot pass while the tool is broken."""
    proc = subprocess.run(
        [sys.executable, str(_SCRIPT)], capture_output=True, text=True,
    )
    assert proc.returncode == 0, (
        "settings missing from .env.example:\n"
        f"{proc.stderr}\n"
        "Add them with: python scripts/check_env_example.py --emit"
    )


@pytest.mark.skipif(not _SCRIPT.exists(), reason="checkout layout")
def test_the_emitter_carries_the_config_comments() -> None:
    """The explanations already live above each field in config.py, often with
    the incident that motivated the value. A generated block must reuse them
    rather than leave a bare `KEY=` for someone to guess at."""
    sys.path.insert(0, str(_SCRIPT.parent))
    import check_env_example as checker

    comments = checker._field_comments()
    # A field with a known multi-line explanation.
    assert any("RFC1918" in c for c in comments.get("trusted_proxy_cidrs", []))
    # Section banners belong to the section, not to the field beneath them.
    assert not any("──" in c for block in comments.values() for c in block)


# ── unknown env keys ──────────────────────────────────────────────────


def test_unknown_env_keys_are_reported(tmp_path) -> None:
    """`extra="ignore"` hid `DEVICE_RATE_LIMIT_PER_DAY` and `LLM_PREMIUM` in
    the repo's own `.env` for months — both retired, both still set, nothing
    ever said so."""
    from shruti_chat.config import warn_unknown_env_keys

    env = tmp_path / ".env"
    env.write_text(
        "# a comment\n"
        "PORT=8080\n"
        "DEVICE_RATE_LIMIT_PER_DAY=5\n"
        "LLM_PREMIUM=some/model\n"
        "\n"
    )

    assert warn_unknown_env_keys(env) == ["DEVICE_RATE_LIMIT_PER_DAY", "LLM_PREMIUM"]


def test_a_clean_env_file_reports_nothing(tmp_path) -> None:
    from shruti_chat.config import warn_unknown_env_keys

    env = tmp_path / ".env"
    env.write_text("PORT=8080\nLOG_LEVEL=info\n")

    assert warn_unknown_env_keys(env) == []


def test_a_missing_env_file_is_not_an_error(tmp_path) -> None:
    from shruti_chat.config import warn_unknown_env_keys

    assert warn_unknown_env_keys(tmp_path / "nope.env") == []


# ── insecure defaults ─────────────────────────────────────────────────


def test_prod_still_refuses_to_boot_with_dev_defaults() -> None:
    from shruti_chat.config import Settings

    with pytest.raises(Exception) as err:
        Settings(_env_file=None, env="prod")
    assert "dev-token" in str(err.value) or "cors_allow_origins" in str(err.value)


def test_prod_boots_once_the_defaults_are_overridden() -> None:
    from shruti_chat.config import Settings

    s = Settings(
        _env_file=None, env="prod",
        cors_allow_origins="https://app.example",
        app_shared_token="a-real-secret",
    )
    assert s.insecure_defaults() == []


def test_dev_defaults_are_reported_even_outside_prod() -> None:
    """The whole point: `env` is what gets forgotten, so the report must not
    depend on it. A prod deploy that lost ENV boots with wildcard CORS and the
    shared admin token, and used to say nothing at all."""
    from shruti_chat.config import Settings, warn_insecure_defaults

    problems = warn_insecure_defaults(Settings(_env_file=None, env="dev"))

    assert len(problems) == 2
    assert any("cors_allow_origins" in p for p in problems)
    assert any("app_shared_token" in p for p in problems)


def test_a_configured_service_reports_nothing() -> None:
    from shruti_chat.config import Settings, warn_insecure_defaults

    s = Settings(
        _env_file=None, env="dev",
        cors_allow_origins="https://app.example",
        app_shared_token="a-real-secret",
    )
    assert warn_insecure_defaults(s) == []
