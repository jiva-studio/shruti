"""Trust-boundary for the `X-Lectorium-Region` header (#728).

The RU reverse proxy tags every forwarded request with
`X-Lectorium-Region: ru` so the global backend can gate PII writes.
This contract is symmetrically defended in the FastAPI layer: only
loopback / RFC1918 sources are trusted to set the header. Public peers
get their value silently dropped — no error, no leak of whether the
header was honoured.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import Request

from lectorium_chat.api._region import extract_region


def _request(headers: dict[str, str], client_host: str | None) -> Request:
    """Build a minimal Request stub that exposes only headers + client.host."""
    scope: dict = {
        "type": "http",
        "method": "POST",
        "path": "/chat",
        "headers": [
            (k.lower().encode(), v.encode()) for k, v in headers.items()
        ],
    }
    req = Request(scope)
    # Override `request.client` — Starlette pulls it from scope["client"]
    # which is a (host, port) tuple. We bypass with a SimpleNamespace
    # because the test only reads `.host`.
    object.__setattr__(req, "_client", SimpleNamespace(host=client_host))
    # Starlette's Request.client property reads from scope["client"];
    # set it directly for completeness.
    if client_host is not None:
        scope["client"] = (client_host, 0)
    return Request(scope)


@pytest.mark.parametrize("trusted_host", ["127.0.0.1", "::1", "10.0.0.5", "172.16.0.1", "192.168.1.42"])
def test_region_header_honoured_from_trusted_source(trusted_host: str) -> None:
    req = _request({"X-Lectorium-Region": "ru"}, client_host=trusted_host)
    assert extract_region(req) == "ru"


@pytest.mark.parametrize("untrusted_host", ["8.8.8.8", "62.109.31.177", "1.1.1.1"])
def test_region_header_ignored_from_untrusted_source(untrusted_host: str) -> None:
    req = _request({"X-Lectorium-Region": "ru"}, client_host=untrusted_host)
    assert extract_region(req) is None


def test_region_header_absent_returns_none_even_from_trusted_source() -> None:
    req = _request({}, client_host="127.0.0.1")
    assert extract_region(req) is None


def test_region_header_lower_cased_and_trimmed() -> None:
    req = _request({"X-Lectorium-Region": "  RU  "}, client_host="10.0.0.5")
    assert extract_region(req) == "ru"


def test_region_header_missing_client_returns_none() -> None:
    req = _request({"X-Lectorium-Region": "ru"}, client_host=None)
    assert extract_region(req) is None
