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

import logging
import os
import sys

import structlog

from shruti_chat.config import get_settings
from shruti_chat.observability.sentry import set_sentry_tag


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

_REGION_REDACTED_MARKER = "[redacted:ru]"


def drop_pii(logger, method_name, event_dict):  # noqa: ANN001 — structlog processor signature
    """structlog processor — strip PII keys before any other formatter
    sees the dict. Runs early in `shared_processors` so context-bound
    PII (via `bind_contextvars(email=...)`) is also caught, not just
    per-call kwargs."""
    for k in list(event_dict.keys()):
        if k in SENSITIVE_KEYS:
            event_dict.pop(k, None)
    return event_dict


def redact_ru_message_bodies(logger, method_name, event_dict):  # noqa: ANN001 — structlog processor signature
    """Drop `messages[].content` from access logs when the bound `region`
    contextvar is `"ru"` (#728). Free-text chat bodies originating in
    Russia must not be persisted on global infra; the structured fields
    (message role, lengths, intent, scores) are still logged so the
    debug surface stays useful."""
    if event_dict.get("region") != "ru":
        return event_dict
    messages = event_dict.get("messages")
    if isinstance(messages, list):
        event_dict["messages"] = [
            {**m, "content": _REGION_REDACTED_MARKER}
            if isinstance(m, dict) and "content" in m
            else m
            for m in messages
        ]
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

    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        # PII drop happens BEFORE add_log_level / EventRenamer so the
        # sanitised dict is what every subsequent processor (and the
        # JSON renderer) sees. Position 1 = after contextvars merge
        # (so context-bound PII is also caught), before structlog
        # formatters. SENSITIVE_KEYS lives at module level — extend
        # there if a new PII shape is introduced.
        drop_pii,
        # Region-aware redaction of message bodies. Must run after
        # `merge_contextvars` (which surfaces the `region` bound at the
        # API layer) and before the JSON renderer.
        redact_ru_message_bodies,
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

    # Bind base context to every log. Field names match Datadog's
    # reserved attributes (`service`, `env`, `version`) so its tag-from-
    # log pipeline picks them up without extra processors.
    structlog.contextvars.bind_contextvars(
        service="shruti-chat",
        env=settings.env,
        version=settings.service_version,
        pid=os.getpid(),
    )


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
    # Same id on the Sentry scope, so an issue deep-links to the Langfuse
    # trace that produced it — the prompts, the model calls and the retrieval
    # scores behind the failure, which no stack trace can show. No-op when
    # Sentry is disabled or absent.
    set_sentry_tag("trace_id", trace_id)
    if langfuse_trace_id:
        set_sentry_tag("langfuse_trace_id", langfuse_trace_id)


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
