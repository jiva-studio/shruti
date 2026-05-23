"""Structured JSON logging via structlog.

Matches the chat service's setup (modules/services/chat/.../observability/logging.py)
so a Datadog log search can span both services with the same facets.

Every line is one JSON object on stdout with:
  timestamp (ISO/UTC), level, message,
  service=lectorium-share-audio, env, version, pid,
  + whatever the call site bound (request_id, user_id, source_key, …).
"""

from __future__ import annotations

import logging
import os
import sys

import structlog


_BASE_FIELDS = ("request_id", "user_id")


def setup_logging(*, service_version: str, env: str, level: str = "info") -> None:
    timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp")
    log_level = getattr(logging, level.upper(), logging.INFO)

    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        # Rename structlog's default "event" → "message" so Datadog's
        # standard attribute lights up.
        structlog.processors.EventRenamer("message"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        timestamper,
    ]

    structlog.configure(
        processors=shared_processors
        + [structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.make_filtering_bound_logger(log_level),
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
    root.setLevel(log_level)

    # Base context attached to every record.
    structlog.contextvars.bind_contextvars(
        service="lectorium-share-audio",
        env=env,
        version=service_version,
        pid=os.getpid(),
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)


def bind_request_context(*, request_id: str) -> None:
    """Bind per-request fields for the lifetime of one HTTP request.

    Call in the FastAPI middleware on request enter; unbind on response.
    """
    structlog.contextvars.bind_contextvars(request_id=request_id)


def clear_request_context() -> None:
    structlog.contextvars.unbind_contextvars(*_BASE_FIELDS)
