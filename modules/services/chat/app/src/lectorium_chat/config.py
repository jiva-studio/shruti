"""Application settings, loaded from environment variables.

All providers (LLM, embedder) are wired here through a single Settings object;
unused providers stay inert because their keys are empty.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


# RFC1918 docker private ranges — the peers Caddy can reach us from inside
# the compose network. Named (rather than inlined in the field default) so
# the validator can fall back to it when the env var is set but blank.
_DEFAULT_TRUSTED_PROXY_CIDRS = ["172.16.0.0/12", "192.168.0.0/16", "10.0.0.0/8"]


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
    # Langfuse credentials. Read from `Settings` rather than `os.environ`
    # directly so they are discoverable — `LANGFUSE_FORCE_FALLBACK` in
    # particular is the single most behaviour-changing switch in the service
    # (it disables prompt management wholesale) and was documented nowhere.
    langfuse_host: str | None = None
    langfuse_public_key: str | None = None
    langfuse_secret_key: str | None = None
    # Skip every Langfuse network call: prompts come from the bundled .md and
    # no traces are emitted. Used by eval runs and local dev.
    langfuse_force_fallback: bool = False
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
    # Per-call hard cap on every Redis client (cache, rate limit,
    # idempotency, turn store). Deliberately tight: Redis is a fast path
    # and a slow one must degrade rather than hold the turn.
    redis_op_timeout_s: float = 0.2
    # L2 circuit breaker: N consecutive failures open it for this long,
    # then one probe re-closes. L1 keeps serving while it is open.
    cache_circuit_threshold: int = 3
    cache_circuit_open_s: float = 30.0

    # ── S3 ──────────────────────────────────────────────────────────────
    s3_bucket: str = "akds-lectorium"
    s3_region: str = "us-east-1"
    s3_endpoint: str | None = None
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    # Public CDN base for client-facing media URLs (recitation audio etc.).
    # Bunny.net edge (US+EU); compose maps LECTORIUM_MEDIA_BASE_URL -> this.
    media_base_url: str = "https://akds-lectorium.b-cdn.net"

    # ── Postgres ────────────────────────────────────────────────────────
    database_url: str = "postgresql://chat:chat@localhost:5432/chat"
    # Connection pool. Sized for a research turn's fanout burst; the
    # matching ceiling on how much of it ONE turn may take at once is
    # `fanout_db_concurrency`, so the two are tuned together.
    # `command_timeout_s` bounds query EXECUTION, not the wait for a free
    # connection — asyncpg exposes no pool-level acquire timeout.
    db_pool_min_size: int = 5
    db_pool_max_size: int = 50
    db_command_timeout_s: float = 15.0
    # Ceiling on ANN lanes one turn runs against Postgres at once. Round 0
    # fans out sub_queries x 5 lanes, which unbounded is ~60 concurrent
    # acquires from a single turn.
    fanout_db_concurrency: int = 8

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
    llm_fallback: str = "openrouter/anthropic/claude-haiku-4.5"
    # Transient-error resilience for every provider LLM call. On a
    # retryable error (timeout / 429 / 5xx / connection) the provider
    # retries the SAME model up to `llm_max_retries` times with
    # exponential backoff (`llm_retry_base_delay_s * 2**attempt` + jitter)
    # before escalating to `llm_fallback`. Set retries to 0 to disable.
    llm_max_retries: int = 2
    llm_retry_base_delay_s: float = 0.5
    # Cheap one-shot model for small auxiliary tasks (chat-session titling,
    # suggested follow-up questions) — picked separately from the chat agent
    # for cost. Lecture outlines are generated by lectorium-mcp, not here.
    llm_cheap: str = "openrouter/google/gemini-2.5-flash-lite"
    # Per-request timeout for the LiteLLM one-shot path (/title, /questions).
    # These bypass the LLMPort adapter, which has its own 180s cap — LiteLLM
    # was left on its library defaults, so a hung upstream held the HTTP
    # request open indefinitely. They are short structured calls against the
    # cheap model; 20s is generous for one.
    llm_oneshot_timeout_s: float = 20.0
    # Ceiling for a STREAMED generation on the same LiteLLM path (the
    # proactive turn). Matches the OpenRouter adapter's own stream cap so
    # both LLM stacks fail on the same horizon.
    llm_stream_timeout_s: float = 180.0

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
    # Citation translator (opt-in `translate_citations`). Translates verbatim
    # corpus prose (transcript / verse translation / commentary / media) into
    # the answer language when no native variant exists. Gemini Flash is
    # multilingual, cheap, and already vetted; the model is part of the
    # persistent-cache key, so swapping it via env (e.g. to Claude for
    # Serbian) mints fresh rows without touching old ones. NOT deepseek.
    llm_translate: str = "openrouter/google/gemini-2.5-flash"
    # Out-of-corpus fallback ("memory-pass"). When the corpus has no relevant
    # material, answer from the model's general knowledge (clearly disclaimed),
    # then re-search the corpus on sub-questions derived from that answer and
    # weave in any genuine hits. A capable Claude is the default — the answer is
    # user-facing prose on niche doctrine, where the cheap planner models drift.
    llm_fallback_knowledge: str = "openrouter/anthropic/claude-sonnet-4.6"
    # Master switch for the memory-pass fallback. Off ⇒ a corpus-insufficient
    # turn keeps the canned «не нашёл в корпусе» refusal. Per-turn override via
    # POST /chat body.config.enable_corpus_fallback (like enable_planner).
    enable_corpus_fallback: bool = True

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
    # PROCESS-WIDE cap on concurrent rerank calls, shared by every turn — not
    # a per-turn budget. A WIDE turn makes ~4-6 rerank calls (fanout pool per
    # round, the attribution border gate, per-thesis Stage 1/2), so at 2 a
    # single turn serialised most of its own reranking and two concurrent
    # turns starved each other. Each call is I/O-bound and capped by
    # `rerank_timeout_s`; the limit exists to bound spend and Voyage-side
    # rate limits, not local CPU.
    rerank_concurrency: int = 8
    rerank_timeout_s: float = 10.0
    # Circuit breaker over the rerank provider. Every call site already
    # degrades to cosine ordering on an exception, so an outage was already
    # "correct" — it just cost `rerank_timeout_s` on every rerank of every
    # turn first. After N consecutive failures the calls fail immediately for
    # `rerank_circuit_open_s`, then one probe re-opens. Tunable because
    # provider flakiness is exactly what an operator needs to react to
    # mid-incident, without a rebuild.
    rerank_circuit_threshold: int = 3
    rerank_circuit_open_s: float = 30.0

    # ── Add-to-library: external lecture search + ingest broker (#1226) ──
    # PRO-only "add an external lecture to my library". The multi-provider
    # search resolver tries these in order; each adapter is inert until its
    # credential is set (only YouTube Data API v3 is a real, keyed adapter —
    # the rest are structured stubs). All optional: a keyless deploy simply
    # finds no candidates for a non-URL query (a pasted link still works).
    youtube_api_key: str | None = None          # YouTube Data API v3 (primary)
    serpapi_api_key: str | None = None          # SerpApi (free tier fallback)
    dataforseo_login: str | None = None         # DataForSEO Basic-auth login
    dataforseo_password: str | None = None      # DataForSEO Basic-auth password
    # Optional BCP-47 region bias for YouTube search results. Empty = global.
    lecture_search_region: str = ""
    # yt-dlp fallback is off by default (the container ships no yt_dlp binary
    # / no egress). Flip on only where the package + network are present.
    lecture_search_ytdlp_enabled: bool = False
    # Per-provider hard timeout inside the resolver's ordered fallback.
    lecture_search_timeout_s: float = 4.0

    # Ingest broker (#1224). When a PRO user adds a lecture, chat XADDs an
    # `ingest.request` onto this Redis Stream for the ingest worker to pick
    # up. Distinct URL from the cache/rate-limit Redis so the broker can live
    # on its own instance. Unset → the publisher no-ops (logs the intent),
    # so the feature degrades gracefully before #1224 is deployed.
    streams_redis_url: str | None = None
    ingest_request_stream: str = "ingest.request"

    # Track-lifecycle events for the private per-user RAG lane (#1227). The
    # orchestrator / library emit `track.ready` (transcript indexed + owned),
    # `track.linked` (owned), `library.unlinked` (owned removed) onto this
    # Redis Stream. The chat service runs a consumer-group reader that indexes
    # the transcript under kind='user_track' and maintains the `owned` ACL
    # projection. Shares STREAMS_REDIS_URL with the ingest broker; unset URL ⇒
    # the consumer never starts (feature off, no-op).
    track_events_stream: str = "track.events"
    track_events_group: str = "chat-indexer"
    track_events_consumer: str = "chat-1"

    # Corpus-promotion events (#1236). The publish-service emits `track.published`
    # when an approved user track is promoted into the published corpus. The chat
    # service consumes it to graft that track's already-indexed `user_track`
    # chunks onto the public `track_transcript` lane and drop the `owned` ACL
    # (see indexer.run._graft_promoted_track). Shares STREAMS_REDIS_URL; unset
    # URL ⇒ the consumer never starts (feature off, no-op). The indexer-time
    # (re)index of the public transcript remains the safety net.
    track_published_stream: str = "track.published"
    track_published_group: str = "chat-graft"
    track_published_consumer: str = "chat-1"

    # In-app help corpus (the `help_get` tool). Path inside the image; the
    # Dockerfile COPYs `modules/docs/help` there.
    help_corpus_dir: Path = Path("/app/docs/help")

    # Build stamps baked in by CI (Dockerfile ARG -> ENV) and surfaced on
    # /healthz so an operator can confirm Watchtower rolled the new image.
    lectorium_build_sha: str = ""
    lectorium_build_time: str = ""

    # ── Indexer ─────────────────────────────────────────────────────────
    catalog_dir: Path = Path("/var/lib/chat")
    # Fractional values are allowed (e.g. 0.25 = every 15 min). The loop
    # floors the effective interval at 60s regardless (see indexer/run.py).
    indexer_interval_hours: float = 6
    indexer_langs: str = "ru,en"
    indexer_bootstrap_on_start: bool = True
    # Concurrent transcript workers per run. Each holds a pool connection
    # and an embedding call, and the indexer shares both with live traffic.
    indexer_concurrency: int = 8

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
    # one IP. Caddy edge has its own per-IP limits (1000/hour on /chat,
    # 120/min on /auth/anonymous); this is the daily budget that survives
    # short bursts.
    ip_rate_limit_per_day: int = 2000

    # ── Turn admission ──────────────────────────────────────────────────
    # The daily caps above bound VOLUME, not CONCURRENCY: nothing stopped
    # every quota-holder from having a turn in flight at the same moment.
    # Turns run detached (a dropped client does not cancel one), so they
    # pile up rather than drain with the socket.
    #
    # Ceiling on producers in flight on this replica. Over it, /chat answers
    # 503 with Retry-After and refunds the charge — a bounded rejection the
    # client retries, instead of everyone queueing behind a saturated pool.
    max_in_flight_turns: int = 24
    # Hard wall-clock budget for one turn. Worst case without it is ~7 ReAct
    # iterations x the 180s LLM timeout — ~21 minutes of billed generation for
    # a client that walked away after the first token.
    turn_budget_s: float = 300.0
    # How often a running turn re-reads the CROSS-REPLICA cancel flag. The
    # in-process event is checked every time regardless, so on a
    # single-replica deploy this only bounds a Stop routed elsewhere.
    cancel_poll_interval_s: float = 1.0
    # Turn-buffer lifetimes. `running` is the heartbeat-refreshed liveness
    # window (lapses => a resuming client reads the turn as orphaned);
    # `result` is how long a finished answer stays fetchable; `cancel` is
    # the cross-replica Stop flag.
    turn_running_ttl_s: int = 180
    turn_result_ttl_s: int = 86_400
    turn_cancel_ttl_s: int = 180

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
        default_factory=lambda: list(_DEFAULT_TRUSTED_PROXY_CIDRS),
    )

    # Additional source IPs / CIDRs allowed to set X-Lectorium-Region.
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
        be replaced by `["10.0.0.0/8,192.168.0.0/16"]` (one bad entry).

        A blank value means "not configured", NOT "trust nobody". Compose
        renders an unset `${VAR:+…}` substitution as an empty string, which
        pydantic-settings sees as a present value — that emptied the list and
        left `ProxyHeadersMiddleware(trusted_hosts=[])` ignoring every
        X-Forwarded-For, collapsing the per-IP rate limit onto Caddy's bridge
        address. Fall back to the defaults instead.
        """
        if isinstance(value, str):
            entries = [s.strip() for s in value.split(",") if s.strip()]
            return entries or list(_DEFAULT_TRUSTED_PROXY_CIDRS)
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

        Dev / staging keep the relaxed defaults so local hacking and CI smoke
        runs don't need to set them.
        """
        if self.env == "prod" and self.insecure_defaults():
            raise ValueError(
                "development defaults are forbidden when env=prod: "
                + "; ".join(self.insecure_defaults())
            )
        return self

    def insecure_defaults(self) -> list[str]:
        """Development defaults that would open the service if left in place.

        Separate from the prod guard on purpose. That guard is armed by
        `env == "prod"` — the ONE variable most likely to be forgotten, and
        forgetting it disarms every check while the service reports healthy.
        Nothing else distinguishes a production container from a laptop (the
        insecure combination IS the normal local one), so instead of guessing,
        this is reported unconditionally at boot and on /status: a prod deploy
        that lost `ENV` still leaves a loud, greppable trace.
        """
        problems: list[str] = []
        if self.cors_allow_origins.strip() == "*":
            problems.append(
                "cors_allow_origins='*' — any web origin can call this service"
            )
        if self.app_shared_token == "dev-token":
            problems.append(
                "app_shared_token='dev-token' — the admin gate on /status and "
                "/reindex is effectively open"
            )
        return problems

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


_settings: Settings | None = None


def warn_insecure_defaults(settings: "Settings | None" = None) -> list[str]:
    """Say so at boot when development defaults are live, whatever `env` says.

    The prod guard raises, but only if `env == "prod"`. This is the net under
    it: a deploy that forgot `ENV` boots with wildcard CORS and the shared
    admin token and reports healthy, and nothing anywhere mentioned it.
    """
    s = settings or get_settings()
    problems = s.insecure_defaults()
    if problems:
        import logging

        logging.getLogger(__name__).warning(
            "insecure_defaults_active",
            extra={"env": s.env, "problems": problems},
        )
        print(
            f"WARNING: development defaults are active (env={s.env}): "
            + "; ".join(problems)
        )
    return problems


def warn_unknown_env_keys(env_file: str | Path | None = None) -> list[str]:
    """Warn about keys in the dotenv file that no longer map to a setting.

    `extra="ignore"` means a misspelled or retired variable is silently
    discarded — and it had been, for months: the repo's own `.env` still
    carried `DEVICE_RATE_LIMIT_PER_DAY` and `LLM_PREMIUM`, neither of which
    exists any more, and nothing ever said so.

    Warn rather than `extra="forbid"`. Forbid does catch exactly this case
    (verified: it ignores unrelated process env vars and rejects stale dotenv
    keys), but it turns a stale `.env` into a hard boot failure. On a running
    service that trades a silent config bug for an outage — worse, and on the
    deploy path where you least want a surprise. Returns the unknown keys so
    callers/tests can assert on them.
    """
    path = Path(env_file) if env_file is not None else Path(
        Settings.model_config.get("env_file", ".env")
    )
    if not path.exists():
        return []
    known = {name.upper() for name in Settings.model_fields}
    unknown: list[str] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key = line.split("=", 1)[0].strip().upper()
        if key and key not in known:
            unknown.append(key)
    if unknown:
        # Not `log` — config.py is imported before logging is configured.
        import logging

        logging.getLogger(__name__).warning(
            "unknown_env_keys",
            extra={"keys": sorted(set(unknown)), "env_file": str(path)},
        )
        print(
            f"WARNING: {path} sets keys that are not settings and are ignored: "
            f"{', '.join(sorted(set(unknown)))}",
        )
    return sorted(set(unknown))


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
