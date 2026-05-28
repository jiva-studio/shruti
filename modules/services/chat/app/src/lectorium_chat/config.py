"""Application settings, loaded from environment variables.

All providers (LLM, embedder) are wired here through a single Settings object;
unused providers stay inert because their keys are empty.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ── service ─────────────────────────────────────────────────────────
    port: int = 8080
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    service_version: str = "dev"
    # Deployment environment. Surfaces in every log line as `env` so
    # Datadog can tag and route by stage. compose/.env should override
    # to "prod" on the VPS.
    env: Literal["dev", "staging", "prod"] = "dev"

    # ── observability ──────────────────────────────────────────────────
    # Per-stage `stage_ms` timing logs. Enabled for baseline collection;
    # sample rate is deterministic per trace_id so all stages of a sampled
    # turn co-occur, which keeps the per-turn breakdown coherent.
    stage_timing_enabled: bool = True
    stage_timing_sample_rate: float = 1.0

    # ── cache (Redis L2 + in-proc L1) ──────────────────────────────────
    # If redis_url is unset, only L1 runs (per-process LRU). cache_enabled
    # false bypasses both tiers entirely; useful for A/B comparisons.
    redis_url: str | None = None
    cache_enabled: bool = True

    # ── S3 ──────────────────────────────────────────────────────────────
    s3_bucket: str = "akds-lectorium"
    s3_region: str = "us-east-1"
    s3_endpoint: str | None = None
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None

    # ── Postgres ────────────────────────────────────────────────────────
    database_url: str = "postgresql://chat:chat@localhost:5432/chat"

    # ── LLM providers ───────────────────────────────────────────────────
    # Selects the active adapter at composition root. The Russia VPS will
    # deploy with `yandex` or `gigachat`; global stays on `openrouter`.
    # The chosen branch must have its credentials populated — boot fails
    # otherwise (see `_validate_llm_provider_credentials` below).
    llm_provider: Literal["openrouter", "yandex", "gigachat"] = "openrouter"

    openrouter_api_key: str | None = None

    # GigaChat (Sber) — OAuth2 client-credentials flow. The new
    # `GigaChatLLMProvider` reads CLIENT_ID + CLIENT_SECRET (+ scope)
    # and exchanges them for a short-lived access token. The legacy
    # `gigachat_api_key` field stays for the litellm shim in
    # `agent/llm.py` until that's removed in Wave 9.
    gigachat_api_key: str | None = None
    gigachat_scope: str = "GIGACHAT_API_PERS"
    gigachat_client_id: str | None = None
    gigachat_client_secret: str | None = None
    # Optional path to the Russian Trusted Root CA bundle. GigaChat ships
    # its own CA chain — production must mount it here. Empty falls back
    # to httpx's default verification.
    gigachat_ca_path: str | None = None

    # YandexGPT 5 (Foundation Models). The adapter accepts either an
    # Api-Key (simpler) or an IAM token (short-lived, refreshed by the
    # deploy host). Folder id is always required to build the model URI
    # `gpt://<folder>/<model>/<version>`.
    yandex_gpt_api_key: str | None = None
    yandex_gpt_folder_id: str | None = None
    yandex_iam_token: str | None = None

    anthropic_api_key: str | None = None
    openai_api_key: str | None = None

    llm_default: str = "openrouter/deepseek/deepseek-chat"
    llm_fallback: str = "openrouter/anthropic/claude-3-haiku"
    # Outline generation is a one-shot JSON-mode call, not the chat agent
    # itself — picked separately for cost (~$0.0007 per lecture, see
    # /tmp/outline_bench.py).
    llm_outline: str = "openrouter/google/gemini-2.0-flash-001"

    # Research pipeline knobs.
    # Query planner + topic extractor share a model — both are short
    # structured-JSON calls. Flash-Lite is cheap and fast enough.
    llm_query_planner: str = "openrouter/google/gemini-3.1-flash-lite"
    # Synthesis planner is a heavier structured-JSON call: it must rank
    # 15-25 notes and pick which back which thesis. Lite was observed to
    # hallucinate broken supporting_notes refs ~5% on the bench; Flash
    # (full, not Lite) handles the attribution selection reliably.
    llm_synthesis_planner: str = "openrouter/google/gemini-2.5-flash"

    # ── Embedder ────────────────────────────────────────────────────────
    # Provider routes to the right credential block / base_url.
    embed_provider: Literal["openrouter", "openai", "yandex", "gigachat"] = "openrouter"
    # Provider-specific model id, e.g. "openai/text-embedding-3-small" via
    # OpenRouter, or "text-embedding-3-small" via OpenAI direct. For
    # Yandex's asymmetric pair this is the document-side model
    # (`text-search-doc/latest`); the query side reads `embed_query_model`.
    embed_model: str = "openai/text-embedding-3-small"
    # Must match what the model returns — 1536 for text-embedding-3-small,
    # 256 (verify against API) for Yandex text-search-doc, 1024 for
    # GigaChat EmbeddingsGigaR.
    embed_dim: int = 1536
    # Only used by asymmetric embedding providers (Yandex). The query
    # encoder differs from the document encoder; both must share the
    # same dimensionality.
    embed_query_model: str = ""
    # Prefixes prepended to inputs before embedding. Required by the e5
    # family (`query: ` / `passage: `) and similar instruction-tuned
    # models; empty for OpenAI text-embedding-3-* and bge-m3, which are
    # prefix-free. Both indexing and query paths read the same setting,
    # so a model swap is a pure env change.
    embed_query_prefix: str = ""
    embed_doc_prefix: str = ""

    yandex_embed_api_key: str | None = None
    yandex_embed_folder_id: str | None = None
    gigachat_embed_api_key: str | None = None

    # Base URL override for the embedder. When unset, the openai
    # embed_provider branch hits the public OpenAI endpoint (EU
    # behaviour, unchanged). When set, it hits an OpenAI-compatible
    # upstream — e.g. the self-hosted TEI container at
    # http://embedder:8080/v1 on RU. Any future deployment swapping
    # embedding backends only needs to flip this env var; no code change.
    embed_base_url: str | None = None

    # Bounded parallelism for any LLM/embedding provider that respects
    # it. Default 2 is conservative for a fresh Yandex Cloud folder
    # where Foundation Models RPS quota is ~3-5; operators with bumped
    # quotas (or providers without strict RPS limits — OpenRouter,
    # GigaChat) can raise via env. Provider adapters read these via
    # the composition root.
    embed_concurrency: int = 2
    llm_concurrency: int = 2

    # ── Indexer ─────────────────────────────────────────────────────────
    catalog_dir: Path = Path("/var/lib/chat")
    indexer_interval_hours: int = 6
    indexer_langs: str = "ru,en"
    indexer_bootstrap_on_start: bool = True

    # ── Abuse mitigation ────────────────────────────────────────────────
    app_shared_token: str = ""

    # ── JWT verification ────────────────────────────────────────────────
    # Path to the auth service's public key. Mounted into the container
    # at /secrets/public.pem by compose (read-only). RS256 only.
    jwt_public_key_path: Path = Path("/secrets/public.pem")
    # Optional directory of `<kid>.pub.pem` files. When set the verifier
    # loads them into a kid → key map so the auth service can rotate
    # signing keys without invalidating outstanding tokens. The legacy
    # `public.pem` filename inside the dir is mapped to kid `v1`.
    jwt_public_keys_dir: Path | None = None

    # Per-(scope, user) daily limits. Three tiers:
    #   anon     — /auth/anonymous-minted JWT (`anonymous=true`)
    #   free     — signed-in but no active RC entitlement
    #   pro      — signed-in with active entitlement (`tier="pro"`)
    # Anon vs free is a meaningful step (signin = +7 daily chat messages)
    # so the user has a reason to bother with OAuth. Tuning starting
    # points — revise from telemetry (ratelimit_blocked_total metric in
    # Phase 9).
    chat_anon_per_day: int = 3
    chat_free_per_day: int = 10
    chat_pro_per_day: int = 200
    # /title is a separate cheap call (~40 tokens out, gemini-flash);
    # session-starts are normal multi-per-day, so headroom is generous.
    title_anon_per_day: int = 10
    title_free_per_day: int = 50
    title_pro_per_day: int = 500
    # /questions = "suggest 3-4 chips" fired on transcript fragment
    # selection. ~400 tokens out; noisier on the device than /title.
    questions_anon_per_day: int = 10
    questions_free_per_day: int = 50
    questions_pro_per_day: int = 500
    # /chat/feedback = thumbs up/down + optional category/comment on
    # any assistant message. The POST itself is cheap (3× Langfuse score
    # ingests at most); cap is generous to allow a user re-flipping
    # judgement across many messages without hitting a wall.
    feedback_anon_per_day: int = 30
    feedback_free_per_day: int = 200
    feedback_pro_per_day: int = 2000
    # Per-IP cap (uniform across scopes). Defence-in-depth on top of the
    # per-user cap — covers an attacker spinning up many anon-JWTs from
    # one IP. Caddy edge has its own per-IP limit (200/hour); this is the
    # daily budget that survives short bursts.
    ip_rate_limit_per_day: int = 2000

    # ── CORS ────────────────────────────────────────────────────────────
    # Comma-separated list of allowed origins. Default `*` keeps dev easy;
    # production override pins to the real app origin via env
    # (CORS_ALLOW_ORIGINS=https://app.lectorium.example,ionic://localhost).
    cors_allow_origins: str = "*"

    # ── Trusted proxy ───────────────────────────────────────────────────
    # Source IPs / CIDRs whose `X-Forwarded-For` header we honour when
    # rewriting `request.client.host`. Anything outside this list keeps
    # the raw peer IP, so an attacker can't spoof their source by
    # injecting the header directly. Defaults cover the RFC1918 docker
    # private ranges — Caddy sits in the same compose network and
    # reaches us via the bridge gateway, which is always inside one of
    # these. Override via env (comma-separated) when fronting from a
    # different proxy topology.
    trusted_proxy_cidrs: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["172.16.0.0/12", "192.168.0.0/16", "10.0.0.0/8"],
    )

    @field_validator("trusted_proxy_cidrs", mode="before")
    @classmethod
    def _split_trusted_proxy_cidrs(cls, value):
        """Accept the env-var form (comma-separated string) and trim entries.

        pydantic-settings parses `TRUSTED_PROXY_CIDRS=10.0.0.0/8,192.168.0.0/16`
        as a single string; without this validator the default list would
        be replaced by `["10.0.0.0/8,192.168.0.0/16"]` (one bad entry)."""
        if isinstance(value, str):
            return [s.strip() for s in value.split(",") if s.strip()]
        return value

    @model_validator(mode="after")
    def _validate_llm_provider_credentials(self) -> "Settings":
        """Fail-boot when a NEW LLM provider (yandex/gigachat) has no creds.

        Catches misconfiguration at startup instead of at first request
        for the Russia-resident providers. The check intentionally does
        NOT cover the `openrouter` branch — `OpenRouterLLMProvider`'s
        constructor has raised on missing API key since long before
        this PR, and existing tests construct `Settings(...)` without
        passing the key (they never reach the adapter). Keeping the
        openrouter check at adapter level preserves that contract.

        For `yandex` / `gigachat` the fields are new and no test
        constructs a Settings with `llm_provider` set to those values
        without also providing creds, so the validator is safe to make
        unconditional. The Russia VPS at Wave 7 will boot with these
        envs populated.
        """
        if self.llm_provider == "yandex":
            if not self.yandex_gpt_folder_id:
                raise ValueError(
                    "LLM_PROVIDER=yandex requires YANDEX_GPT_FOLDER_ID"
                )
            if not self.yandex_gpt_api_key and not self.yandex_iam_token:
                raise ValueError(
                    "LLM_PROVIDER=yandex requires YANDEX_GPT_API_KEY or "
                    "YANDEX_IAM_TOKEN"
                )
        elif self.llm_provider == "gigachat":
            if not self.gigachat_client_id or not self.gigachat_client_secret:
                raise ValueError(
                    "LLM_PROVIDER=gigachat requires GIGACHAT_CLIENT_ID and "
                    "GIGACHAT_CLIENT_SECRET"
                )
        return self

    @model_validator(mode="after")
    def _forbid_insecure_prod_defaults(self) -> "Settings":
        """Fail-boot when running in prod with development defaults.

        Catches two footguns where forgetting to override an env var would
        otherwise silently open the service:
          - `cors_allow_origins == "*"` → any web origin can call us
          - `app_shared_token == "dev-token"` → the shared-secret gate is
            effectively disabled
        Dev / staging keep the relaxed defaults so local hacking and CI
        smoke runs don't need to set them.
        """
        if self.env == "prod":
            if self.cors_allow_origins.strip() == "*":
                raise ValueError(
                    "cors_allow_origins='*' is forbidden when env=prod; "
                    "set CORS_ALLOW_ORIGINS to the real app origin(s)"
                )
            if self.app_shared_token == "dev-token":
                raise ValueError(
                    "app_shared_token='dev-token' is forbidden when env=prod; "
                    "set APP_SHARED_TOKEN to a non-default secret"
                )
        return self

    # ── Derived helpers ────────────────────────────────────────────────
    @property
    def catalog_db_path(self) -> Path:
        return self.catalog_dir / "catalog.db"

    @property
    def library_db_path(self) -> Path:
        """Local path for the published library.db snapshot."""
        return self.catalog_dir / "library.db"

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
            return f"{self.s3_endpoint.rstrip('/')}/{self.s3_bucket}"
        return f"https://{self.s3_bucket}.s3.{self.s3_region}.amazonaws.com"


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
