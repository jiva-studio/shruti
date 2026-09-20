"""The deny-list and the title recovery, without the SDK installed.

Both are pure functions over the `(event, hint)` pair Sentry hands `before_send`,
so they are testable — and stay tested — in an environment that has no
`sentry-sdk`. Only `init_sentry` needs the real package, and its only untested
branch is the one that returns False.
"""

from __future__ import annotations

import logging

import pytest

from shruti_chat.config import Settings
from shruti_chat.domain.ports.llm_provider import ProviderUnavailable
from shruti_chat.observability.sentry import (
    before_send,
    init_sentry,
    is_expected_error,
    set_sentry_tag,
)


def _record(payload: dict) -> logging.LogRecord:
    """A record shaped the way structlog's `wrap_for_formatter` leaves it —
    the event dict itself as `msg`, not a formatted string."""
    return logging.LogRecord(
        name="shruti_chat.test",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg=payload,
        args=(),
        exc_info=None,
    )


# ── deny-list ─────────────────────────────────────────────────────────────


def test_a_provider_outage_is_not_an_issue() -> None:
    exc = ProviderUnavailable("429 from the upstream")
    assert is_expected_error({}, {"exc_info": (type(exc), exc, None)})


def test_a_wrapped_provider_outage_is_still_not_an_issue() -> None:
    """LangGraph re-raises node exceptions in its own frames, so the type that
    matters is almost never the outermost one."""
    try:
        try:
            raise ProviderUnavailable("out of credits")
        except ProviderUnavailable as inner:
            raise RuntimeError("graph node failed") from inner
    except RuntimeError as outer:
        assert is_expected_error({}, {"exc_info": (type(outer), outer, None)})


def test_a_chat_unavailable_turn_is_not_an_issue() -> None:
    hint = {"log_record": _record({"message": "chat_graph_failed", "code": "chat_unavailable"})}
    assert is_expected_error({}, hint)
    assert before_send({}, hint) is None


def test_cancellation_is_not_an_issue() -> None:
    event = {"exception": {"values": [{"type": "CancelledError", "value": ""}]}}
    assert is_expected_error(event, {})


def test_a_real_failure_is_reported() -> None:
    exc = RuntimeError("boom")
    event = {"exception": {"values": [{"type": "RuntimeError", "value": "boom"}]}}
    hint = {"exc_info": (type(exc), exc, None), "log_record": _record({"message": "tool_call_error"})}

    assert not is_expected_error(event, hint)
    assert before_send(event, hint) is event


# ── title recovery ────────────────────────────────────────────────────────


def test_the_issue_is_titled_with_the_event_name_not_a_dict_repr() -> None:
    """`wrap_for_formatter` puts the whole event dict in `record.msg`, so the
    SDK's own title would be a Python dict repr — unreadable, and unique per
    call because every bound field is in the string, which breaks grouping."""
    hint = {"log_record": _record({"message": "chat_graph_failed", "request_id": "r-1"})}
    event: dict = {"logentry": {"message": "{'message': 'chat_graph_failed', ...}", "params": []}}

    assert before_send(event, hint) is event
    assert event["logentry"]["message"] == "chat_graph_failed"
    assert "params" not in event["logentry"]


def test_the_bound_fields_survive_as_extra() -> None:
    hint = {"log_record": _record({"message": "tool_call_error", "tool": "verse_get"})}
    event: dict = {}

    before_send(event, hint)

    assert event["extra"]["tool"] == "verse_get"
    # The rendered traceback string is dropped — the SDK carries a structured one.
    assert "message" not in event["extra"]


def test_a_plain_string_log_is_left_alone() -> None:
    """Third-party libraries log strings, not structlog dicts."""
    record = logging.LogRecord("uvicorn", logging.ERROR, __file__, 1, "plain text", (), None)
    event: dict = {"logentry": {"message": "plain text"}}

    assert before_send(event, {"log_record": record}) is event
    assert event["logentry"]["message"] == "plain text"


# ── init ──────────────────────────────────────────────────────────────────


def test_no_dsn_means_sentry_stays_off() -> None:
    assert init_sentry(Settings(_env_file=None, sentry_dsn=None)) is False


def test_tagging_is_safe_when_sentry_is_absent() -> None:
    set_sentry_tag("langfuse_trace_id", "abc-123")


def test_the_sample_rate_is_configurable() -> None:
    s = Settings(_env_file=None, sentry_traces_sample_rate=0.5)
    assert s.sentry_traces_sample_rate == pytest.approx(0.5)
