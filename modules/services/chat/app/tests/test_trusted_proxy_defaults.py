"""A blank TRUSTED_PROXY_CIDRS must not mean "trust nobody".

`docker-compose.yml` built the value with `${LECTORIUM_REGION_HEADER_TRUSTED_SOURCES:+…}`.
With that variable unset the substitution collapses to an empty string — but the
key is still emitted, so the container gets a SET-but-blank env var.
pydantic-settings sees a present value, the validator returned `[]`, and
`ProxyHeadersMiddleware(trusted_hosts=[])` then honoured no X-Forwarded-For at
all: every request was attributed to Caddy's bridge address and the per-IP daily
cap collapsed into one shared bucket. The compose comment claimed the opposite
("Settings' defaults take over").

Compose now always emits the RFC1918 ranges; these tests pin the config-side
guarantee so the trap cannot be reintroduced from any other caller.

`tests/integration/test_xff.py` covers the populated form, but is gated behind
`--integration`, so the defect had no unconditional coverage.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from lectorium_chat.config import _DEFAULT_TRUSTED_PROXY_CIDRS, Settings


def _settings(monkeypatch: pytest.MonkeyPatch, raw: str) -> Settings:
    monkeypatch.setenv("TRUSTED_PROXY_CIDRS", raw)
    return Settings(_env_file=None, database_url="postgres://test",
                    s3_bucket="x", s3_region="us-east-1")


def test_blank_value_falls_back_to_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _settings(monkeypatch, "").trusted_proxy_cidrs == _DEFAULT_TRUSTED_PROXY_CIDRS


def test_separators_only_falls_back_to_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _settings(monkeypatch, " , ,  ").trusted_proxy_cidrs == _DEFAULT_TRUSTED_PROXY_CIDRS


def test_populated_value_still_replaces_the_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s = _settings(monkeypatch, "10.5.0.0/16, 192.0.2.1")
    assert s.trusted_proxy_cidrs == ["10.5.0.0/16", "192.0.2.1"]


async def test_blank_value_still_honours_xff_from_the_bridge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The behaviour the config guarantee exists for: a docker-bridge peer's
    X-Forwarded-For is honoured even when the env var arrived blank."""
    app = FastAPI()

    @app.get("/whoami")
    async def whoami(request: Request) -> dict[str, str]:
        return {"ip": request.client.host if request.client else ""}

    wrapped = ProxyHeadersMiddleware(
        app, trusted_hosts=_settings(monkeypatch, "").trusted_proxy_cidrs,
    )
    transport = ASGITransport(app=wrapped, client=("172.18.0.1", 51234))
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/whoami", headers={"x-forwarded-for": "198.51.100.7"})

    assert r.json()["ip"] == "198.51.100.7"
