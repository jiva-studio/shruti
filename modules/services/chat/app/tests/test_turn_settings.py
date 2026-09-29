"""`TurnSettings`: the slice of `Settings` a turn reads, copied in by the use case."""

from __future__ import annotations

from shruti_chat.agent.graph.turn_context import TurnSettings, turn_settings_from
from shruti_chat.config import Settings
from shruti_chat.research.constants import DEFAULT_FANOUT_DB_CONCURRENCY


def _settings(**overrides) -> Settings:
    return Settings(
        _env_file=None, database_url="postgres://test",
        s3_bucket="x", s3_region="us-east-1", **overrides,
    )


def test_the_defaults_are_the_deployment_defaults() -> None:
    # A context built without settings (a test, a tool run outside a turn)
    # must behave like an unconfigured deployment, not like a third opinion.
    assert turn_settings_from(_settings()) == TurnSettings()
    assert _settings().fanout_db_concurrency == DEFAULT_FANOUT_DB_CONCURRENCY


def test_every_knob_is_copied_from_settings() -> None:
    got = turn_settings_from(_settings(
        llm_cheap="m-cheap",
        llm_fallback_knowledge="m-knowledge",
        media_base_url="https://cdn.example",
        enable_corpus_fallback=False,
        fanout_db_concurrency=3,
        indexer_langs="en,ru,uk",
    ))
    assert got == TurnSettings(
        llm_cheap="m-cheap",
        llm_fallback_knowledge="m-knowledge",
        media_base_url="https://cdn.example",
        enable_corpus_fallback=False,
        fanout_db_concurrency=3,
        corpus_langs=("en", "ru", "uk"),
    )


def test_no_settings_means_the_defaults() -> None:
    assert turn_settings_from(None) == TurnSettings()
