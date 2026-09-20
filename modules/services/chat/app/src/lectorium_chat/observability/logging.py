"""Structured JSON logging via structlog.

Every log line is one JSON object on stdout with a stable base context
(`service`, `version`, `pid`) merged with per-call context bound by the caller
(`request_id`, `device_id`, `track_id`, etc.).

## Multi-agent tracing fields

The chat service is moving to a LangGraph multi-agent flow (router →
worker → synthesizer). To make logs traceable across node boundaries,
all per-turn callers bind:

- `trace_id`     — one id per chat turn, attached to every log line
                   produced while that turn is in flight. Generated at
                   turn entry (chat_turn.py wrapper).
- `request_id`   — HTTP request id (from header or generated). May equal
                   `trace_id` for single-turn requests; differs when one
                   request runs multiple proactive turns.
- `agent_role`   — which node is logging: "router" | "research_worker" |
                   "catalog_worker" | "action_worker" | "help_worker" |
                   "synthesizer" | "main" (composition wrapper).
- `parent_trace_id` — reserved for nested-graph use (Stage 6+). Empty
                   today; future work where one chat turn spawns
                   sub-turns will populate this.

Use `bind_turn_context` at turn entry and `bind_node_role` at the start
of each node body. Use `clear_turn_context` at turn exit to avoid
leakage between turns served on the same async task.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import sys

import structlog

from lectorium_chat.config import get_settings


# PII keys that MUST NOT reach stdout / Loki / Langfuse traces. The
# auth service mints opaque UUIDs for `user_id`; nothing downstream
# should be carrying these fields, but `drop_pii` is belt-and-braces
# in case a future tool or LLM-result envelope drags one in.
# Extend this set when introducing a new PII shape — keep the
# defence at this single choke-point rather than scattering filters
# across call sites.
SENSITIVE_KEYS: frozenset[str] = frozenset(
    {"email", "apple_id", "google_play_id", "ip", "phone", "real_name"}
)

# Loggers uvicorn configures in its own `LOGGING_CONFIG`: each gets a
# private StreamHandler plus `propagate: false`, so nothing they emit
# ever reaches the structlog formatter installed on the root logger.
# `setup_logging` strips those handlers and re-enables propagation.
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access", "uvicorn.asgi")

# Request paths whose SUCCESSFUL access lines are dropped before
# formatting (see `DropAccessLogPaths` for the status rule). /healthz
# is polled by the container healthcheck every 15 s plus two blackbox
# probes; over 7 days it was 120,666 of 145,361 shipped lines — 83% of
# the whole service's log volume, and 99.7% of its access lines.
SILENCED_ACCESS_PATHS: frozenset[str] = frozenset({"/healthz"})

# Fallback salt for `client_ip_hash` when no PII salt is configured.
# Regenerated per process, so hashes stay comparable within one process
# but reveal nothing across restarts.
_PROCESS_SALT = secrets.token_hex(16)


class DropAccessLogPaths(logging.Filter):
    """Drop uvicorn access records whose path is in `SILENCED_ACCESS_PATHS`.

    uvicorn formats access lines lazily — `record.args` is
    `(client_addr, method, full_path, http_version, status_code)` — so
    the path is matched without rendering the message.

    Only successful probes are silenced. A healthcheck that answers 4xx/5xx
    without raising leaves no `uvicorn.error` traceback behind, so dropping
    it by path alone would erase the only record that the probe failed —
    exactly the line an operator goes looking for.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if not isinstance(args, tuple) or len(args) != 5:
            return True
        if str(args[2]).split("?", 1)[0] not in SILENCED_ACCESS_PATHS:
            return True
        try:
            status = int(args[4])  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return True
        return status >= 400


def add_base_context(base: dict):
    """Build a processor that stamps the service identity onto every event.

    These fields used to be bound with `bind_contextvars` at the end of
    `setup_logging`. That binding lives in the contextvars copy owned by
    whichever task ran the call — uvicorn's lifespan task — so request
    handlers, background tasks and threads logged without `service`, and
    Loki (which derives the label by JSON-parsing the line) filed them
    under no service at all. A processor runs on every event in every
    context, including foreign stdlib records replayed through
    `foreign_pre_chain`.

    `setdefault` so an explicit per-call or contextvar-bound value still
    wins.
    """

    def processor(logger, method_name, event_dict):  # noqa: ANN001 — structlog processor signature
        for key, value in base.items():
            event_dict.setdefault(key, value)
        return event_dict

    return processor


def client_ip_hash(ip: str | None) -> str | None:
    """Salted, truncated sha256 of a client IP.

    `ip` is in `SENSITIVE_KEYS`, so `drop_pii` strips a raw address from
    every event — including `rate_limit_hit`, the one line that wants it
    (one hash against many user_ids = a CGNAT peer storm; one user_id
    with a growing count = a single hammering user). Hashing keeps that
    correlation without persisting the address. The salt matters: the
    IPv4 space is small enough to enumerate against an unsalted digest.

    The salt is `LOG_IP_SALT` when configured, which keeps hashes
    comparable across restarts and replicas; otherwise a per-process
    random salt, which still holds correlation over the minutes a storm
    is spotted on and never writes anything reversible.
    """
    if not ip:
        return None
    salt = get_settings().log_ip_salt or _PROCESS_SALT
    return hashlib.sha256(f"{salt}:{ip}".encode()).hexdigest()[:16]


def drop_pii(logger, method_name, event_dict):  # noqa: ANN001 — structlog processor signature
    """structlog processor — strip PII keys before any other formatter
    sees the dict. Runs early in `shared_processors` so context-bound
    PII (via `bind_contextvars(email=...)`) is also caught, not just
    per-call kwargs."""
    for k in list(event_dict.keys()):
        if k in SENSITIVE_KEYS:
            event_dict.pop(k, None)
    return event_dict


_TURN_FIELDS = (
    "trace_id",
    "request_id",
    "agent_role",
    "parent_trace_id",
    # `langfuse_trace_id` is the uuid4 used as the Langfuse root-trace
    # ID. Bound here so every log line carries it; Grafana's Loki
    # derived field `langfuse_trace_id=([a-f0-9-]+)` cross-links a log
    # entry to its Langfuse trace URL.
    "langfuse_trace_id",
)


def setup_logging() -> None:
    settings = get_settings()

    # Datadog auto-parses `timestamp` + `level` + `message`; ISO/UTC is
    # the format their pipeline expects when no source is declared.
    timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp")
    level = getattr(logging, settings.log_level.upper(), logging.INFO)

    # Field names match Datadog's reserved attributes (`service`, `env`,
    # `version`) so its tag-from-log pipeline picks them up without extra
    # processors; promtail lifts `service` into the Loki label of the
    # same name.
    base_context = {
        "service": "lectorium-chat",
        "env": settings.env,
        "version": settings.service_version,
        "pid": os.getpid(),
    }

    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        # Stamp service/env/version/pid on every event, native or
        # foreign, in every context. Runs after merge_contextvars so a
        # bound override still wins (the processor uses setdefault).
        add_base_context(base_context),
        # PII drop happens BEFORE add_log_level / EventRenamer so the
        # sanitised dict is what every subsequent processor (and the
        # JSON renderer) sees. Position 1 = after contextvars merge
        # (so context-bound PII is also caught), before structlog
        # formatters. SENSITIVE_KEYS lives at module level — extend
        # there if a new PII shape is introduced.
        drop_pii,
        # add_log_level emits `level` which Datadog recognises as severity.
        structlog.stdlib.add_log_level,
        # Rename structlog's default `event` field → `message`. Datadog's
        # standard attribute is `message`; everything else gets cleaner
        # search by aligning here.
        structlog.processors.EventRenamer("message"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        timestamper,
    ]

    structlog.configure(
        processors=shared_processors
        + [
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
        foreign_pre_chain=shared_processors,
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)

    # Hand uvicorn's own loggers to the root formatter. Done here rather
    # than through `--log-config`: a config file would have to be kept in
    # step across the Dockerfile, every compose file and local dev, and
    # uvicorn applies it before settings are loaded, so it could not
    # share this `foreign_pre_chain` or log level. Doing it in code fixes
    # every entrypoint at once. Uvicorn's handful of pre-lifespan boot
    # lines ("Started server process") still print plain — they are
    # emitted before this runs.
    for name in _UVICORN_LOGGERS:
        uv = logging.getLogger(name)
        uv.handlers = []
        uv.filters = [f for f in uv.filters if not isinstance(f, DropAccessLogPaths)]
        uv.propagate = True
    logging.getLogger("uvicorn.access").addFilter(DropAccessLogPaths())

    # `warnings.warn` output (pydantic, LiteLLM, langgraph deprecations)
    # goes straight to stderr as plain text and is a large share of the
    # unlabelled lines that are not uvicorn's. Route it through the
    # `py.warnings` logger, which propagates to the root handler above.
    logging.captureWarnings(True)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


# ── Per-turn binding helpers ─────────────────────────────────────────────


def bind_turn_context(
    *,
    trace_id: str,
    request_id: str | None = None,
    agent_role: str = "main",
    parent_trace_id: str | None = None,
    langfuse_trace_id: str | None = None,
) -> None:
    """Bind multi-agent tracing fields for the lifetime of one chat turn.

    Call once at turn entry (e.g. in `application/chat_turn.py` before
    invoking the graph). The fields are inherited by every log line
    produced inside this async context, including from worker nodes
    that don't explicitly know about logging.

    `langfuse_trace_id` is the Langfuse root-trace UUID; logs carry it
    so a Grafana Loki query can derive-field jump straight to the
    matching Langfuse trace URL.
    """
    structlog.contextvars.bind_contextvars(
        trace_id=trace_id,
        request_id=request_id or trace_id,
        agent_role=agent_role,
        parent_trace_id=parent_trace_id or "",
        langfuse_trace_id=langfuse_trace_id or "",
    )


def bind_node_role(role: str) -> None:
    """Set `agent_role` for the duration of one node's execution.

    Call at the top of each graph node body. The previous value is
    overwritten in-place; clean restoration on node exit is not needed
    because the next node will overwrite again. If a node calls into
    code that emits its own role (e.g. synthesizer invokes a sub-helper),
    that sub-helper rebinds and the outer role resumes only if we
    explicitly restore — keep nodes flat to avoid this concern.
    """
    structlog.contextvars.bind_contextvars(agent_role=role)


def clear_turn_context() -> None:
    """Unbind all per-turn tracing fields. Call at turn exit (finally
    block) to keep async tasks reusable across turns without leakage."""
    structlog.contextvars.unbind_contextvars(*_TURN_FIELDS)
