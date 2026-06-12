"""Unit tests for the `langfuse_span` telemetry helper — best-effort spans
that surface non-LLM stages (retrieval / augmentation) in the trace without
ever breaking a turn."""

from __future__ import annotations

import lectorium_chat.observability.langfuse_client as lf


def test_span_noop_when_disabled(monkeypatch) -> None:
    monkeypatch.setattr(lf, "_LANGFUSE", None)
    ran = False
    with lf.langfuse_span("retrieval.embed") as span:
        assert span is None
        ran = True
    assert ran  # the wrapped block always runs


def test_span_opens_and_closes_when_enabled(monkeypatch) -> None:
    calls: list[str] = []

    class FakeSpan:
        def __enter__(self):
            return "SPAN"

        def __exit__(self, *exc):
            calls.append("exit")
            return False

    class FakeClient:
        def start_as_current_span(self, *, name):
            calls.append(f"open:{name}")
            return FakeSpan()

    monkeypatch.setattr(lf, "_LANGFUSE", FakeClient())
    with lf.langfuse_span("retrieval.fetch_refs") as span:
        assert span == "SPAN"
    assert calls == ["open:retrieval.fetch_refs", "exit"]


def test_span_survives_open_failure(monkeypatch) -> None:
    """A telemetry failure must never break the wrapped work."""

    class BoomClient:
        def start_as_current_span(self, *, name):
            raise RuntimeError("otel down")

    monkeypatch.setattr(lf, "_LANGFUSE", BoomClient())
    ran = False
    with lf.langfuse_span("retrieval.x") as span:
        assert span is None
        ran = True
    assert ran
