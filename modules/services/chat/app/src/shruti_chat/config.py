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
    s3_bucket: str = "shruti-engine"
    s3_region: str = "us-east-1"
    s3_endpoint: str | None = None
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None

    # ── Postgres ────────────────────────────────────────────────────────
    database_url: str = "postgresql://chat:chat@localhost:5432/chat"

    # ── LLM providers ───────────────────────────────────────────────────
    # Single-provider deployment: every region ships OpenRouter. Russia
    # traffic reaches us through the RU proxy (see #728); there is no
    # in-region LLM stack anymore.
    llm_provider: Literal["openrouter"] = "openrouter"

    openrouter_api_key: str | None = None

    anthropic_api_key: str | None = None
    openai_api_key: str | None = None

    llm_default: str = "openrouter/deepseek/deepseek-chat"
    # Escalation model the provider switches to when the primary model
    # errors (after exhausting same-model transient retries). For
    # streaming calls it only fires before the first chunk reaches the
    # client — a mid-stream failure can't be re-rolled onto another model.
    llm_fallback: str = "openrouter/anthropic/claude-3-haiku"
    # Transient-error resilience for every provider LLM call. On a
    # retryable error (timeout / 429 / 5xx / connection) the provider
    # retries the SAME model up to `llm_max_retries` times with
    # exponential backoff (`llm_retry_base_delay_s * 2**attempt` + jitter)
    # before escalating to `llm_fallback`. Set retries to 0 to disable.
    llm_max_retries: int = 2
    llm_retry_base_delay_s: float = 0.5
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
    # Conclusion writer is the cheapest call in the pipeline — just a
    # 2-3 sentence closing paragraph from a list of theses. Fires only
    # when synthesis_planner skipped conclusion on a 3+ thesis answer.
    llm_conclusion_writer: str = "openrouter/google/gemini-3.1-flash-lite"

    # ── Embedder ────────────────────────────────────────────────────────
    # Provider routes to the right credential block / base_url.
    embed_provider: Literal["openrouter", "openai"] = "openrouter"
    # Provider-specific model id, e.g. "openai/text-embedding-3-small" via
    # OpenRouter, or "text-embedding-3-small" via OpenAI direct.
    embed_model: str = "openai/text-embedding-3-small"
    # Must match what the model returns — 1536 for text-embedding-3-small.
    embed_dim: int = 1536
    # Reserved for future asymmetric embedding providers; both encoders
    # must share dimensionality. Unused today.
    embed_query_model: str = ""
    # Prefixes prepended to inputs before embedding. Required by the e5
    # family (`query: ` / `passage: `) and similar instruction-tuned
    # models; empty for OpenAI text-embedding-3-* and bge-m3, which are
    # prefix-free. Both indexing and query paths read the same setting,
    # so a model swap is a pure env change.
    embed_query_prefix: str = ""
    embed_doc_prefix: str = ""

    # Base URL override for the embedder. When unset, the openai
    # embed_provider branch hits the public OpenAI endpoint. When set, it
    # routes to an OpenAI-compatible upstream. Any deployment swapping
    # embedding backends only needs to flip this env var; no code change.
    embed_base_url: str | None = None

    # Bounded parallelism for LLM / embedding provider calls. Provider
    # adapters read these via the composition root.
    embed_concurrency: int = 2
    llm_concurrency: int = 2
    # Per-request timeout (seconds) on the embeddings HTTP client. Without
    # this the OpenAI SDK defaults to 600s — a hung embedding call on the
    # query hot path would stall the turn far past the research-stage
    # wait_for budgets that wrap downstream of it. 30s comfortably covers
    # a 96-input indexing batch while bounding the single-query call.
    embed_timeout_s: float = 30.0

    # ── Reranker ────────────────────────────────────────────────────────
    # Cross-encoder rerank over the ANN candidate pool. ON by default, but
    # `get_reranker` returns None when the key is missing (provider=voyage)
    # → the pipeline degrades to the cosine path. So default-on never
    # bricks a keyless deploy.
    rerank_provider: Literal["none", "voyage", "tei"] = "voyage"
    rerank_model: str = "rerank-2"
    voyage_api_key: str | None = None       # required for provider=voyage
    rerank_base_url: str | None = None      # future self-hosted (tei)
    rerank_concurrency: int = 2
    rerank_timeout_s: float = 10.0

    # ── Indexer ─────────────────────────────────────────────────────────
    catalog_dir: Path = Path("/var/lib/chat")
    indexer_interval_hours: int = 6
    indexer_langs: str = "ru,en"
    indexer_bootstrap_on_start: bool = True

    # ── Abuse mitigation ────────────────────────────────────────────────
    app_shared_token: str = ""

    # ── JWT verification ────────────────────────────────────────────────
    # Path to the auth service's `v1` public key. Mounted into the
    # container at /secrets/public.pem by compose (read-only). RS256
    # only. Single-kid deployment — see jwt_verifier.py.
    jwt_public_key_path: Path = Path("/secrets/public.pem")

    # Salt for the salted-sha256 hash applied to `user_id` on Langfuse
    # traces originating in the RU region. Empty / unset disables the
    # hashing and the raw `user_id` is sent — leave unset outside prod.
    langfuse_pii_salt: str | None = None

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
    # Flat per-day caps for cheap non-chat endpoints. The tier split was
    # de-facto unused (the only meaningful caller is the mobile app,
    # which sends one per UI action) so the three-way matrix collapses
    # to one knob each: same number for anonymous, free, and Pro.
    title_per_day: int = 500
    questions_per_day: int = 500
    feedback_per_day: int = 500
    # DEPRECATED: legacy per-tier caps kept so prod .env overrides don't
    # fail boot. Read by nothing — see `_user_limit_for` (flat now).
    title_anon_per_day: int = 10
    title_free_per_day: int = 50
    title_pro_per_day: int = 500
    questions_anon_per_day: int = 10
    questions_free_per_day: int = 50
    questions_pro_per_day: int = 500
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
    # (CORS_ALLOW_ORIGINS=https://app.shruti.example,ionic://localhost).
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

    # Additional source IPs / CIDRs allowed to set X-Shruti-Region.
    # Loopback + RFC1918 are always trusted (sibling compose services);
    # this knob is for the RU proxy's PUBLIC egress IP, which is what
    # `request.client.host` resolves to after ProxyHeadersMiddleware
    # rewrites the peer to the leftmost untrusted XFF entry. Empty in
    # dev / single-region deploys. Comma-separated env form.
    region_header_trusted_sources: Annotated[list[str], NoDecode] = Field(
        default_factory=list,
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

    @field_validator("region_header_trusted_sources", mode="before")
    @classmethod
    def _split_region_header_trusted_sources(cls, value):
        """Same comma-split shape as trusted_proxy_cidrs."""
        if isinstance(value, str):
            return [s.strip() for s in value.split(",") if s.strip()]
        return value

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
