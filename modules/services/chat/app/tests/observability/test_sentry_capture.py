"""End-to-end: a real SDK, the real `init_sentry`, the real logging chain.

`test_sentry.py` covers `before_send` as a pure function over a hand-built
`(event, hint)` pair. That is exactly the shape of test that let two defects
through — both live in the *handover* between structlog, stdlib `logging` and
the SDK, which a hand-built pair skips over:

* `format_exc_info` popped `exc_info` before `LoggingIntegration` ever saw the
  record, so every `log.exception` produced a tracebackless event and both
  branches of the deny-list were dead code in production;
* the SDK's default `include_local_variables=True` attached every frame's
  locals — in this service, the user's question and the rendered prompt.

So these tests assert on the event the transport is actually handed.

Skipped where `sentry-sdk` is not installed; CI installs it from
`pyproject.toml`.
"""

from __future__ import annotations

import io
import json
import logging
from typing import Any

import pytest
import structlog

sentry_sdk = pytest.importorskip("sentry_sdk")

from lectorium_chat.config import Settings  # noqa: E402
from lectorium_chat.domain.ports.llm_provider import ProviderUnavailable  # noqa: E402
from lectorium_chat.observability.logging import setup_logging  # noqa: E402
from lectorium_chat.observability.sentry import init_sentry  # noqa: E402


# A string that exists ONLY as a local variable in the raising frame. If it
# turns up anywhere in the event, frame locals are being shipped.
PLANTED_LOCAL = "sentry-locals-canary-9f3a1c-what-is-the-soul"

DSN = "https://public@o0.ingest.sentry.io/1"


class _CapturingTransport(sentry_sdk.transport.Transport):
    """Keeps events in memory instead of posting them to sentry.io."""

    def __init__(self) -> None:
        super().__init__()
        self.events: list[dict[str, Any]] = []

    def capture_envelope(self, envelope: Any) -> None:
        event = envelope.get_event()
        if event is not None:
            self.events.append(event)


@pytest.fixture
def sentry_events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Boot the service's real Sentry init against a capturing transport.

    `init_sentry` is called unmodified — the options under test
    (`include_local_variables`, `max_request_body_size`, `before_send`) are the
    production ones, not a copy that could drift.
    """
    transport = _CapturingTransport()
    real_init = sentry_sdk.init

    def init_with_capture(**kwargs: Any) -> Any:
        return real_init(transport=transport, **kwargs)

    monkeypatch.setattr(sentry_sdk, "init", init_with_capture)

    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level
    saved_config = structlog.get_config()

    setup_logging()
    assert init_sentry(Settings(_env_file=None, sentry_dsn=DSN)) is True

    yield transport.events

    sentry_sdk.get_client().close()
    structlog.configure(**saved_config)
    root.handlers, root.level = saved_handlers, saved_level


def _log_exception(event: str, exc: BaseException, **fields: Any) -> None:
    """Reproduce a real call site: raise, then `log.exception` in the handler.

    `PLANTED_LOCAL` is bound as a frame local of the raising function, the way
    a question or a rendered prompt is bound on the turn path.
    """

    def raising_frame() -> None:
        user_question = PLANTED_LOCAL  # noqa: F841 — the point of the test
        raise exc

    log = structlog.get_logger("lectorium_chat.tests.sentry")
    try:
        raising_frame()
    except BaseException:
        log.exception(event, **fields)


# ── D2: the event carries a real exception ────────────────────────────────


def test_a_log_exception_reaches_sentry_with_its_traceback(sentry_events) -> None:
    """`format_exc_info` used to strip `exc_info` off the event dict before the
    record was ever built, so the integration had nothing to attach."""
    _log_exception("tool_call_error", RuntimeError("kaboom"), tool="verse_get")

    assert len(sentry_events) == 1
    event = sentry_events[0]

    values = event["exception"]["values"]
    assert values[-1]["type"] == "RuntimeError"
    assert values[-1]["value"] == "kaboom"

    frames = values[-1]["stacktrace"]["frames"]
    assert any(f["function"] == "raising_frame" for f in frames)

    # And the structlog title recovery still applies to the same event.
    assert event["logentry"]["message"] == "tool_call_error"
    assert event["extra"]["tool"] == "verse_get"


def test_the_deny_list_now_actually_fires(sentry_events) -> None:
    """Both `before_send` branches key off exception data. Until the handover
    existed there was none, so a provider outage became an issue anyway."""
    _log_exception("chat_graph_failed", ProviderUnavailable("429 from upstream"))

    assert sentry_events == []


def test_a_chat_unavailable_turn_is_still_dropped_end_to_end(sentry_events) -> None:
    _log_exception("chat_graph_failed", RuntimeError("boom"), code="chat_unavailable")

    assert sentry_events == []


def test_the_rendered_log_line_keeps_its_single_json_object(
    sentry_events,
) -> None:
    """The handover must not make stdlib append a bare traceback after the JSON
    — `ProcessorFormatter` formats a copy of the record, so it does not."""
    handler = logging.getLogger().handlers[0]
    buffer = io.StringIO()
    saved, handler.stream = handler.stream, buffer
    try:
        _log_exception("tool_call_error", RuntimeError("kaboom"))
    finally:
        handler.stream = saved

    line = buffer.getvalue().strip()
    assert "\n" not in line
    payload = json.loads(line)
    assert payload["message"] == "tool_call_error"
    assert "Traceback (most recent call last)" in payload["exception"]


# ── D1: no payload leaves the process ─────────────────────────────────────


def test_frame_locals_never_leave_the_process(sentry_events) -> None:
    """The blocking leak: with the SDK default, `user_question` would be in
    `frames[].vars` of every exception event this service reports."""
    _log_exception("tool_call_error", RuntimeError("kaboom"))

    event = sentry_events[0]
    assert PLANTED_LOCAL not in json.dumps(event, default=repr)

    frames = event["exception"]["values"][-1]["stacktrace"]["frames"]
    assert frames  # the assertion below is only meaningful if there are frames
    assert all("vars" not in f for f in frames)


def test_the_pii_options_are_the_ones_sentry_is_running_with(sentry_events) -> None:
    """Asserted on the live client, not on the source of `init_sentry`."""
    options = sentry_sdk.get_client().options

    assert options["include_local_variables"] is False
    assert options["send_default_pii"] is False
    assert options["attach_stacktrace"] is False
    # The chat POST body is the user's question verbatim.
    assert options["max_request_body_size"] == "never"


def test_no_breadcrumb_carries_the_previous_turn(sentry_events) -> None:
    """`LoggingIntegration(level=None)` means a log line is never a breadcrumb;
    a breadcrumb is the whole structlog event dict, payload included."""
    log = structlog.get_logger("lectorium_chat.tests.sentry")
    log.info("chat_turn_started", question=PLANTED_LOCAL)

    _log_exception("tool_call_error", RuntimeError("kaboom"))

    event = sentry_events[0]
    assert not event.get("breadcrumbs", {}).get("values")
