"""`is_provider_unavailable` — the classifier that decides whether a turn
failure is a provider-availability problem (out of credits / key rejected
/ provider down → calm "chat unavailable") versus a graph bug (→ generic
agent_error).

The motivating incident: OpenRouter returned 402 "Insufficient credits"
56× in one window, which surfaced to authed users as a generic error.
"""

from __future__ import annotations

import openai
import pytest

from lectorium_chat.infra.llm_provider.openrouter import is_provider_unavailable


def _status_error(status: int) -> Exception:
    """An exception that quacks like the openai SDK's APIStatusError —
    only the `status_code` attribute matters to the classifier."""

    class _StatusError(Exception):
        status_code = status

    return _StatusError(f"HTTP {status}")


@pytest.mark.parametrize("status", [401, 402, 403, 408, 429, 500, 502, 503, 504])
def test_availability_status_codes_are_unavailable(status: int) -> None:
    assert is_provider_unavailable(_status_error(status)) is True


@pytest.mark.parametrize("status", [400, 404, 422])
def test_client_side_status_codes_stay_agent_error(status: int) -> None:
    # 400/404/422 mean WE sent something wrong — retrying won't help and
    # it's not a provider outage, so they must NOT be classified unavailable.
    assert is_provider_unavailable(_status_error(status)) is False


def test_connection_and_timeout_types_are_unavailable() -> None:
    req = openai.APIConnectionError(request=None)  # type: ignore[arg-type]
    assert is_provider_unavailable(req) is True


def test_plain_exception_is_not_unavailable() -> None:
    assert is_provider_unavailable(ValueError("bug in our code")) is False


def test_walks_cause_chain() -> None:
    # LangGraph re-raises node failures wrapped in its own frames, so the
    # original 402 is buried in __cause__ — the classifier must dig it out.
    wrapped = RuntimeError("node 'synthesizer' failed")
    wrapped.__cause__ = _status_error(402)
    assert is_provider_unavailable(wrapped) is True


def test_walks_context_chain() -> None:
    inner = _status_error(503)
    try:
        try:
            raise inner
        except Exception:
            raise RuntimeError("graph aborted")  # sets __context__ = inner
    except Exception as outer:
        assert is_provider_unavailable(outer) is True


def test_cycle_in_chain_terminates() -> None:
    # Defensive: a self-referential cause must not hang the walk.
    a = ValueError("a")
    b = ValueError("b")
    a.__cause__ = b
    b.__cause__ = a
    assert is_provider_unavailable(a) is False
