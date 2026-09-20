"""The tracing headers must survive the CORS preflight.

`allow_headers` is an explicit list, and the Capacitor WebView issues a
preflight for any non-simple header. A client that attaches `sentry-trace` /
`baggage` to a host missing them does not merely lose the trace — the
preflight rejects and the chat POST never fires at all. That failure mode has
already cost this list two incidents (`X-Chat-Protocol-Version`,
`Idempotency-Key`), so it gets a test rather than a comment.
"""

from __future__ import annotations

from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from lectorium_chat.main import app


def _allow_headers() -> list[str]:
    for mw in app.user_middleware:
        if mw.cls is CORSMiddleware:
            return [h.lower() for h in mw.kwargs.get("allow_headers", [])]
    raise AssertionError("CORSMiddleware is not installed")


def test_the_sentry_tracing_headers_are_allowed() -> None:
    allowed = _allow_headers()
    assert "sentry-trace" in allowed
    assert "baggage" in allowed


def test_the_existing_chat_headers_are_still_allowed() -> None:
    allowed = _allow_headers()
    for header in ("authorization", "x-chat-protocol-version", "idempotency-key", "x-trace-id"):
        assert header in allowed


def test_a_preflight_carrying_them_is_accepted() -> None:
    response = TestClient(app).options(
        "/chat",
        headers={
            "Origin": "capacitor://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization,sentry-trace,baggage",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
