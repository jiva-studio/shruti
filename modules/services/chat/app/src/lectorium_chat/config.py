"""Application settings, loaded from environment variables.

All providers (LLM, embedder) are wired here through a single Settings object;
unused providers stay inert because their keys are empty.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ── service ─────────────────────────────────────────────────────────
    port: int = 8080
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    service_version: str = "dev"

    # ── S3 ──────────────────────────────────────────────────────────────
    s3_bucket: str = "akds-lectorium"
    s3_region: str = "us-east-1"
    s3_endpoint: str | None = None
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None

    # ── Postgres ────────────────────────────────────────────────────────
    database_url: str = "postgresql://chat:chat@localhost:5432/chat"

    # ── LLM providers ───────────────────────────────────────────────────
    openrouter_api_key: str | None = None
    gigachat_api_key: str | None = None
    gigachat_scope: str = "GIGACHAT_API_PERS"
    yandex_gpt_api_key: str | None = None
    yandex_gpt_folder_id: str | None = None
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None

    llm_default: str = "openrouter/deepseek/deepseek-chat"
    llm_fallback: str = "openrouter/anthropic/claude-3-haiku"
    llm_premium: str = "openrouter/anthropic/claude-3.5-sonnet"
    # Outline generation is a one-shot JSON-mode call, not the chat agent
    # itself — picked separately for cost (~$0.0007 per lecture, see
    # /tmp/outline_bench.py).
    llm_outline: str = "openrouter/google/gemini-2.0-flash-001"

    # ── Embedder ────────────────────────────────────────────────────────
    # Provider routes to the right credential block / base_url.
    embed_provider: Literal["openrouter", "openai", "yandex", "gigachat"] = "openrouter"
    # Provider-specific model id, e.g. "openai/text-embedding-3-small" via
    # OpenRouter, or "text-embedding-3-small" via OpenAI direct.
    embed_model: str = "openai/text-embedding-3-small"
    # Must match what the model returns — 1536 for text-embedding-3-small.
    embed_dim: int = 1536

    yandex_embed_api_key: str | None = None
    yandex_embed_folder_id: str | None = None
    gigachat_embed_api_key: str | None = None

    # ── Indexer ─────────────────────────────────────────────────────────
    catalog_dir: Path = Path("/var/lib/chat")
    indexer_interval_hours: int = 6
    indexer_langs: str = "ru,en"
    indexer_bootstrap_on_start: bool = True

    # ── Abuse mitigation ────────────────────────────────────────────────
    app_shared_token: str = ""
    device_rate_limit_per_day: int = 50
    ip_rate_limit_per_day: int = 200
    # /title is a separate cheap call (~40 tokens out, gemini-flash) so it
    # gets a smaller quota with a separate bucket — heavier than /chat per
    # device because a user starting many sessions in a row is normal, but
    # not infinite. A leaked app_shared_token (it's baked into every APK)
    # without this gate gives an attacker free billable LLM access.
    title_device_rate_limit_per_day: int = 60
    title_ip_rate_limit_per_day: int = 300

    # ── CORS ────────────────────────────────────────────────────────────
    # Comma-separated list of allowed origins. Default `*` keeps dev easy;
    # production override pins to the real app origin via env
    # (CORS_ALLOW_ORIGINS=https://app.lectorium.example,ionic://localhost).
    cors_allow_origins: str = "*"

    # ── Derived helpers ────────────────────────────────────────────────
    @property
    def catalog_db_path(self) -> Path:
        return self.catalog_dir / "catalog.db"

    @property
    def langs(self) -> list[str]:
        return [s.strip() for s in self.indexer_langs.split(",") if s.strip()]

    @property
    def cors_origins(self) -> list[str]:
        """Parsed CORS allow-list. `*` stays as-is (single-element list)."""
        return [s.strip() for s in self.cors_allow_origins.split(",") if s.strip()]

    @property
    def s3_public_url(self) -> str:
        """Base HTTPS URL for public reads when no signing is needed."""
        if self.s3_endpoint:
            return self.s3_endpoint.rstrip("/")
        return f"https://{self.s3_bucket}.s3.{self.s3_region}.amazonaws.com"


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
