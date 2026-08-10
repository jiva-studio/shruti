"""Regression tests for #1557 — chat logs invisible under {service="chat"}.

Promtail derives the Loki `service` label by JSON-parsing each line, so a
line that is not JSON, or is JSON without a `service` key, lands under no
service at all. Two separate causes did that:

- uvicorn's own loggers carry private handlers and `propagate: false`, so
  access/error lines never met the structlog formatter;
- the base context was bound with `bind_contextvars` inside the lifespan
  task, so anything logged from another context came out unlabelled.
"""

from __future__ import annotations

import contextvars
import json
import logging

import pytest
import structlog

from lectorium_chat.observability import logging as obs_logging
from lectorium_chat.observability.logging import (
    DropAccessLogPaths,
    client_ip_hash,
    drop_pii,
    setup_logging,
)


@pytest.fixture
def isolated_logging():
    """Snapshot and restore every global `setup_logging` touches."""
    root = logging.getLogger()
    saved_root = (list(root.handlers), root.level)
    saved_uvicorn = {
        name: (
            list(logging.getLogger(name).handlers),
            list(logging.getLogger(name).filters),
            logging.getLogger(name).propagate,
        )
        for name in obs_logging._UVICORN_LOGGERS
    }
    saved_structlog = structlog.get_config()
    yield
    root.handlers, root.level = saved_root
    for name, (handlers, filters, propagate) in saved_uvicorn.items():
        lg = logging.getLogger(name)
        lg.handlers, lg.filters, lg.propagate = handlers, filters, propagate
    structlog.configure(**saved_structlog)
    logging.captureWarnings(False)


def _access_record(path: str) -> logging.LogRecord:
    """A record shaped exactly like uvicorn's lazily formatted access line."""
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("127.0.0.1:52000", "GET", path, "1.1", 200),
        exc_info=None,
    )


def _last_json_line(captured: str) -> dict:
    return json.loads(captured.strip().splitlines()[-1])


def test_uvicorn_loggers_are_handed_to_the_root_formatter(isolated_logging):
    for name in obs_logging._UVICORN_LOGGERS:
        lg = logging.getLogger(name)
        lg.handlers = [logging.NullHandler()]
        lg.propagate = False

    setup_logging()

    for name in obs_logging._UVICORN_LOGGERS:
        lg = logging.getLogger(name)
        assert lg.handlers == []
        assert lg.propagate is True


def test_healthz_is_dropped_from_the_access_log(isolated_logging):
    setup_logging()

    filters = [
        f for f in logging.getLogger("uvicorn.access").filters
        if isinstance(f, DropAccessLogPaths)
    ]
    assert len(filters) == 1
    assert filters[0].filter(_access_record("/healthz")) is False
    assert filters[0].filter(_access_record("/healthz?probe=blackbox")) is False
    assert filters[0].filter(_access_record("/chat")) is True


def test_the_access_filter_is_not_stacked_on_repeated_setup(isolated_logging):
    setup_logging()
    setup_logging()

    filters = [
        f for f in logging.getLogger("uvicorn.access").filters
        if isinstance(f, DropAccessLogPaths)
    ]
    assert len(filters) == 1


def test_the_access_filter_ignores_non_access_records(isolated_logging):
    record = logging.LogRecord(
        name="uvicorn.error", level=logging.INFO, pathname=__file__, lineno=1,
        msg="Started server process [%d]", args=(1,), exc_info=None,
    )
    assert DropAccessLogPaths().filter(record) is True


def test_foreign_stdlib_records_carry_the_service_label(isolated_logging, capsys):
    setup_logging()

    logging.getLogger("uvicorn.access").handle(_access_record("/chat"))
    logging.getLogger("litellm").warning("third-party deprecation notice")

    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 2
    for line in out:
        assert json.loads(line)["service"] == "lectorium-chat"


def test_the_service_label_survives_a_context_switch(isolated_logging, capsys):
    # The old `bind_contextvars` lived in the contextvars copy owned by the
    # task that ran setup_logging; a sibling task logged without `service`.
    contextvars.Context().run(setup_logging)

    structlog.get_logger("elsewhere").warning("emitted from another context")

    assert _last_json_line(capsys.readouterr().out)["service"] == "lectorium-chat"


def test_client_ip_hash_is_stable_and_hides_the_address():
    hashed = client_ip_hash("203.0.113.7")

    assert hashed == client_ip_hash("203.0.113.7")
    assert hashed != client_ip_hash("203.0.113.8")
    assert "203.0.113.7" not in hashed
    assert client_ip_hash(None) is None
    assert client_ip_hash("") is None


def test_client_ip_hash_survives_drop_pii():
    event = drop_pii(
        None, "warning", {"ip": "203.0.113.7", "client_ip_hash": "0123456789abcdef"}
    )

    assert "ip" not in event
    assert event["client_ip_hash"] == "0123456789abcdef"
