"""Load and failure knobs must be settings, and must be findable.

These are the values an operator reaches for mid-incident: pool size, the
fanout gate, Redis timeouts and breakers, turn admission, the rerank ceiling,
LiteLLM timeouts, indexer concurrency. Every one of them started life as a
module constant, which meant tuning any of them needed a rebuild and a deploy.

This pins two things: they are on `Settings` (so env can override them), and
they appear in `.env.example` (so someone can find them without reading the
source). It is deliberately a fixed list rather than a rule over all settings —
`.env.example` documents well under half of `Settings` today, and closing that
gap properly means generating the file from the model.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from shruti_chat.config import Settings


_LOAD_KNOBS = (
    # Postgres pool + the per-turn gate it is tuned against
    "db_pool_min_size",
    "db_pool_max_size",
    "db_command_timeout_s",
    "fanout_db_concurrency",
    # Redis client behaviour
    "redis_op_timeout_s",
    "cache_circuit_threshold",
    "cache_circuit_open_s",
    # Turn admission + buffer lifetimes
    "max_in_flight_turns",
    "turn_budget_s",
    "cancel_poll_interval_s",
    "turn_running_ttl_s",
    "turn_result_ttl_s",
    "turn_cancel_ttl_s",
    # Reranker
    "rerank_concurrency",
    "rerank_timeout_s",
    "rerank_circuit_threshold",
    "rerank_circuit_open_s",
    # The LiteLLM path, which bypasses LLMPort and its own cap
    "llm_oneshot_timeout_s",
    "llm_stream_timeout_s",
    # Indexer
    "indexer_concurrency",
)


def _env_example_keys() -> set[str]:
    # tests/ -> app/ -> the service root, where .env.example lives.
    path = Path(__file__).resolve().parents[2] / ".env.example"
    if not path.exists():  # pragma: no cover - checkout layout guard
        pytest.skip(".env.example not present in this checkout")
    # Commented-out defaults count as documented — that is how the file
    # records "this exists, here is its default".
    return set(re.findall(r"^#?\s*([A-Z][A-Z0-9_]+)=", path.read_text(), re.M))


@pytest.mark.parametrize("name", _LOAD_KNOBS)
def test_knob_is_a_setting(name: str) -> None:
    assert name in Settings.model_fields, f"{name} is not on Settings"


@pytest.mark.parametrize("name", _LOAD_KNOBS)
def test_knob_is_documented(name: str) -> None:
    assert name.upper() in _env_example_keys(), f"{name.upper()} missing from .env.example"
