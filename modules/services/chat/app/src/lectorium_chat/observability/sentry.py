"""Server-side error aggregation.

Loki holds every `log.exception` as an isolated line: no grouping, no dedup,
no release attribution, no alerting. Sentry adds all four, and the mobile app
already reports into the same `akdasa-studio/letorium` project — so once the
client propagates `sentry-trace`, a crash and the server error that caused it
land on one trace instead of in two systems nobody joins by hand.

Nothing here calls `capture_exception`. `LoggingIntegration(event_level=ERROR)`
picks up all 21 existing `log.exception` sites for free: structlog is
configured with `structlog.stdlib.LoggerFactory()` and the root handler is a
plain stdlib `StreamHandler` (`logging.py`), so every structlog error already
travels through the stdlib `logging` tree that the integration hooks.

That same wiring is why `before_send` has work to do. `wrap_for_formatter`
puts the whole event *dict* in `record.msg`, so the SDK's default title is a
Python dict repr — the server twin of the client's "[object Object]" problem
that `describeConsoleArgs` solves in `monitoring/`. `_normalise_message`
recovers the structlog event name as the title.

The SDK is an optional import: the service runs, and the test suite passes,
in an environment where `sentry-sdk` was never installed.
"""

from __future__ import annotations

from typing import Any

import structlog

from lectorium_chat.config import Settings

try:  # pragma: no cover - exercised by whichever half of the branch is live
    import sentry_sdk
    from sentry_sdk.integrations.logging import LoggingIntegration

    SENTRY_AVAILABLE = True
except ImportError:  # pragma: no cover
    sentry_sdk = None  # type: ignore[assignment]
    LoggingIntegration = None  # type: ignore[assignment]
    SENTRY_AVAILABLE = False


# ── deny-list ─────────────────────────────────────────────────────────────

# Exception types that mean "an upstream we don't own said no", not "our code
# is broken". `ProviderUnavailable` is raised only after retries AND the
# fallback model are spent (domain/ports/llm_provider.py), which is precisely
# the provider-429 / out-of-credits case the client's `isExpectedError` drops.
# `CancelledError` is control flow: a user pressing Stop, or a disconnected
# SSE reader, cancels the producer task by design.
_BENIGN_EXCEPTIONS = frozenset(
    {
        "ProviderUnavailable",
        "CancelledError",
        "ClientDisconnect",
    }
)

# Error CODES the service itself hands the client for a calm retry. When a turn
# ends in `chat_unavailable` the user already saw "try again in a moment" — an
# issue adds nothing, and at provider-outage scale it would bury real bugs.
_BENIGN_CODES = frozenset({"chat_unavailable"})


def _structlog_payload(hint: dict[str, Any]) -> dict[str, Any] | None:
    """The original structlog event dict behind a `LoggingIntegration` event.

    `ProcessorFormatter.wrap_for_formatter` is the final structlog processor
    here, and it passes the event dict through as `record.msg` — so the fields
    a call site bound (`code`, `request_id`, …) survive intact on the record.
    """
    record = hint.get("log_record")
    msg = getattr(record, "msg", None)
    return msg if isinstance(msg, dict) else None


def _exception_types(event: dict[str, Any]) -> set[str]:
    values = (event.get("exception") or {}).get("values") or []
    return {v.get("type") for v in values if isinstance(v, dict) and v.get("type")}


def is_expected_error(event: dict[str, Any], hint: dict[str, Any]) -> bool:
    """True when this event is known noise and must not become an issue.

    The server-side mirror of the client's `isExpectedError` deny-list.
    """
    # Walk the real exception chain when the SDK handed us one: LangGraph
    # re-raises node exceptions inside its own frames, so the type that
    # matters is rarely the outermost one.
    exc_info = hint.get("exc_info")
    if exc_info and len(exc_info) > 1 and isinstance(exc_info[1], BaseException):
        from lectorium_chat.domain.ports.llm_provider import provider_unavailable

        if provider_unavailable(exc_info[1]):
            return True

    if _exception_types(event) & _BENIGN_EXCEPTIONS:
        return True

    payload = _structlog_payload(hint)
    return bool(payload and payload.get("code") in _BENIGN_CODES)


def _normalise_message(event: dict[str, Any], hint: dict[str, Any]) -> None:
    """Retitle a structlog event and hoist its fields into `extra`.

    Without this the issue is titled with a raw dict repr, which both reads
    badly and — because every bound field is part of the string — defeats
    grouping for non-exception events.
    """
    payload = _structlog_payload(hint)
    if not payload:
        return

    name = payload.get("message") or payload.get("event")
    if isinstance(name, str) and name:
        logentry = event.setdefault("logentry", {})
        logentry["message"] = name
        logentry.pop("params", None)
        logentry.pop("formatted", None)

    extra = event.setdefault("extra", {})
    for key, value in payload.items():
        # `exception` holds a rendered traceback string (format_exc_info);
        # the SDK already carries a structured one.
        if key in {"message", "event", "exception", "timestamp", "level"}:
            continue
        extra.setdefault(key, value)


def before_send(event: dict[str, Any], hint: dict[str, Any]) -> dict[str, Any] | None:
    if is_expected_error(event, hint):
        return None
    _normalise_message(event, hint)
    return event


# ── init ──────────────────────────────────────────────────────────────────


def init_sentry(settings: Settings) -> bool:
    """Initialise the SDK. Returns True when Sentry is live.

    A no-op — not an error — when the DSN is unset or the package is absent,
    so dev, tests and CI never need Sentry to exist.
    """
    log = structlog.get_logger(__name__)

    if not settings.sentry_dsn:
        return False
    if not SENTRY_AVAILABLE:
        log.warning("sentry_sdk_missing", hint="install sentry-sdk[fastapi]")
        return False

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.env,
        # Same shape as the mobile release name, so a server issue and the
        # client issue it caused can be filtered by the same deploy.
        release=settings.service_version,
        # ERROR and above becomes an issue; INFO and above becomes a
        # breadcrumb, which is what gives an issue the preceding turn's
        # narrative without a second logging pipeline.
        integrations=[LoggingIntegration(level=None, event_level="ERROR")],
        # User messages, auth headers and IPs must never leave the service.
        # The RU-region redaction in `logging.py` protects the log pipeline;
        # this protects Sentry's.
        send_default_pii=False,
        traces_sample_rate=settings.sentry_traces_sample_rate,
        before_send=before_send,
    )
    log.info(
        "sentry_initialised",
        environment=settings.env,
        traces_sample_rate=settings.sentry_traces_sample_rate,
    )
    return True


def set_sentry_tag(key: str, value: str) -> None:
    """Tag the current scope. Safe to call when Sentry is absent or disabled —
    an uninitialised SDK swallows scope writes, same as the client helper."""
    if not SENTRY_AVAILABLE:
        return
    try:
        sentry_sdk.set_tag(key, value)
    except Exception:  # noqa: BLE001, S110 - observability must never break a turn
        pass
