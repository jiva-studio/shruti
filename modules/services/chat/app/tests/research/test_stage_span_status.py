"""A degraded retrieval stage must say so on its span.

`_safe` opens `retrieval.<stage>` around every pipeline stage and computes an
outcome — ok / timeout / error / provider_unavailable — but only ever wrote it
to the `stage_timing` log line. In the trace the span just ended, so a stage
that timed out and returned nothing looked exactly like a fast one, and the
only record lived in Loki: a different tool from the trace you are reading
while working out why an answer came back thin.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from shruti_chat.research import pipeline as pipeline_mod


class _FakeSpan:
    def __init__(self) -> None:
        self.updates: list[dict[str, Any]] = []

    def update(self, **kwargs: Any) -> None:
        self.updates.append(kwargs)


def _install_span(monkeypatch: pytest.MonkeyPatch) -> _FakeSpan:
    from contextlib import contextmanager

    span = _FakeSpan()

    @contextmanager
    def _fake_span(name: str):
        yield span

    monkeypatch.setattr(pipeline_mod, "langfuse_span", _fake_span)
    return span


async def test_ok_stage_is_marked_default(monkeypatch: pytest.MonkeyPatch) -> None:
    span = _install_span(monkeypatch)

    async def _work():
        return "value"

    got = await pipeline_mod._safe(
        _work, default=None, timeout=5.0, name="embed", request_id="r",
    )

    assert got == "value"
    assert span.updates[-1]["level"] == "DEFAULT"
    assert span.updates[-1]["metadata"]["status"] == "ok"
    assert span.updates[-1]["status_message"] is None


async def test_timeout_is_marked_on_the_span(monkeypatch: pytest.MonkeyPatch) -> None:
    span = _install_span(monkeypatch)

    async def _slow():
        await asyncio.sleep(5)

    got = await pipeline_mod._safe(
        _slow, default="fallback", timeout=0.01, name="fanout", request_id="r",
    )

    # The stage still degrades — that behaviour is unchanged.
    assert got == "fallback"
    # ...but the trace now shows why.
    assert span.updates[-1]["level"] == "WARNING"
    assert span.updates[-1]["metadata"]["status"] == "timeout"
    assert span.updates[-1]["status_message"] == "timeout"


async def test_error_is_marked_on_the_span(monkeypatch: pytest.MonkeyPatch) -> None:
    span = _install_span(monkeypatch)

    async def _boom():
        raise ValueError("nope")

    got = await pipeline_mod._safe(
        _boom, default="fallback", timeout=5.0, name="topic_lookup", request_id="r",
    )

    assert got == "fallback"
    assert span.updates[-1]["metadata"]["status"] == "error"
    assert span.updates[-1]["level"] == "WARNING"


async def test_provider_unavailable_is_marked_and_still_re_raised(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """This one deliberately kills the turn rather than degrading — the span
    must record it on the way out."""
    span = _install_span(monkeypatch)
    monkeypatch.setattr(pipeline_mod, "provider_unavailable", lambda exc: True)

    async def _no_credits():
        raise RuntimeError("out of credits")

    with pytest.raises(RuntimeError):
        await pipeline_mod._safe(
            _no_credits, default=None, timeout=5.0, name="embed", request_id="r",
        )

    assert span.updates[-1]["metadata"]["status"] == "provider_unavailable"
    assert span.updates[-1]["level"] == "WARNING"


async def test_a_broken_span_never_breaks_the_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from contextlib import contextmanager

    class _BadSpan:
        def update(self, **kwargs: Any) -> None:
            raise RuntimeError("langfuse exploded")

    @contextmanager
    def _fake_span(name: str):
        yield _BadSpan()

    monkeypatch.setattr(pipeline_mod, "langfuse_span", _fake_span)

    async def _work():
        return "value"

    assert await pipeline_mod._safe(
        _work, default=None, timeout=5.0, name="embed", request_id="r",
    ) == "value"


async def test_no_span_is_fine(monkeypatch: pytest.MonkeyPatch) -> None:
    """Langfuse disabled — `langfuse_span` yields None."""
    from contextlib import contextmanager

    @contextmanager
    def _fake_span(name: str):
        yield None

    monkeypatch.setattr(pipeline_mod, "langfuse_span", _fake_span)

    async def _work():
        return "value"

    assert await pipeline_mod._safe(
        _work, default=None, timeout=5.0, name="embed", request_id="r",
    ) == "value"
