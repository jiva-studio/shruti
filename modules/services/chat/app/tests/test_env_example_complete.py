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
