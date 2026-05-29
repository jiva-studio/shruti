"""End-to-end trust-chain test for X-Lectorium-Region.

The unit tests in `test_region_middleware.py` poke `extract_region`
directly with a synthesised Request and a chosen `client.host`. They
miss the failure mode where ProxyHeadersMiddleware sits in front of the
app and rewrites `request.client.host` to the leftmost untrusted XFF
entry — if the RU proxy's public egress IP isn't in
`REGION_HEADER_TRUSTED_SOURCES`, the rewrite lands `_region.py` on an
untrusted address and the region tag is silently dropped.

These tests assemble a minimal FastAPI app with both middlewares wired
exactly the way `main.py` does it, then drive it with TestClient using
the proxy-trust knobs we expect operators to set in prod. This is the
test that would have caught the failure mode in CRITICAL #1 first time
through.

TestClient's default peer is the synthetic string "testclient" which
ipaddress can't parse — `_PeerSetter` is the smallest possible ASGI
wrapper that rewrites `scope["client"]` to a real IP so the trust
plumbing has something to evaluate.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from starlette.types import ASGIApp, Receive, Scope, Send
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from lectorium_chat.api._region import extract_region


# Stand-in for the RU proxy's public egress IP — same one shipped as
# the example in .env.example.
RU_PROXY_IP = "62.109.31.177"
UNTRUSTED_IP = "8.8.8.8"


class _PeerSetter:
    """Outermost ASGI layer: pin `scope["client"]` to a chosen IP so
    ProxyHeadersMiddleware's trust check + extract_region's peer lookup
    both see a parseable IPv4 instead of TestClient's synthetic
    "testclient" placeholder."""

    def __init__(self, app: ASGIApp, host: str) -> None:
        self._app = app
        self._host = host

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            scope = dict(scope)
            scope["client"] = (self._host, 0)
        await self._app(scope, receive, send)


def _build_app() -> FastAPI:
    """One handler that echoes back what `extract_region` saw."""
    app = FastAPI()

    @app.get("/_region")
    async def _region(req: Request):
        return {"region": extract_region(req)}

    return app


def _client(
    *,
    peer_host: str,
    proxy_trusted_hosts: list[str] | None = None,
) -> TestClient:
    """Compose: PeerSetter → ProxyHeadersMiddleware → FastAPI.

    `peer_host` is the IP the chat service sees as the raw socket peer
    (before any XFF rewrite). On the live VPS that's the Caddy
    container's bridge IP; tests use 127.0.0.1.
    """
    app = _build_app()
    if proxy_trusted_hosts is not None:
        app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=proxy_trusted_hosts)
    wrapped = _PeerSetter(app, peer_host)
    return TestClient(wrapped)


def _reload_settings_with(
    monkeypatch: pytest.MonkeyPatch,
    *,
    sources: str,
) -> None:
    """Re-import settings with REGION_HEADER_TRUSTED_SOURCES set.

    Settings is a process-wide singleton; tests that mutate env have to
    blow away the cached instance so the new value is picked up.
    """
    from lectorium_chat import config as cfg

    monkeypatch.setenv("REGION_HEADER_TRUSTED_SOURCES", sources)
    monkeypatch.setattr(cfg, "_settings", None)


@pytest.fixture(autouse=True)
def _reset_settings_after(monkeypatch: pytest.MonkeyPatch):
    """Every test must end with a fresh Settings load so cross-test
    env bleed doesn't poison the next case."""
    yield
    from lectorium_chat import config as cfg

    monkeypatch.setattr(cfg, "_settings", None)


def test_loopback_request_with_region_header_is_honoured() -> None:
    """A direct loopback call (no XFF) — RFC1918+loopback is the always-
    trusted floor, no env needed."""
    client = _client(peer_host="127.0.0.1")
    r = client.get("/_region", headers={"X-Lectorium-Region": "ru"})
    assert r.status_code == 200
    assert r.json() == {"region": "ru"}


def test_trusted_xff_from_ru_proxy_is_honoured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """RU proxy public IP listed in REGION_HEADER_TRUSTED_SOURCES.

    ProxyHeadersMiddleware trusts the raw peer (Caddy at 127.0.0.1) and
    rewrites `request.client.host` to the leftmost XFF entry (the RU
    proxy IP). With that IP in REGION_HEADER_TRUSTED_SOURCES,
    extract_region accepts the header.
    """
    _reload_settings_with(monkeypatch, sources=f"{RU_PROXY_IP}/32")
    client = _client(
        peer_host="127.0.0.1",
        proxy_trusted_hosts=["127.0.0.1"],
    )
    r = client.get(
        "/_region",
        headers={
            "X-Forwarded-For": RU_PROXY_IP,
            "X-Lectorium-Region": "ru",
        },
    )
    assert r.status_code == 200
    assert r.json() == {"region": "ru"}


def test_untrusted_public_xff_is_silently_dropped() -> None:
    """A direct public-IP request would be rewritten to that IP and
    _region.py drops the header because it's not in the trusted
    sources list — no error, just region=None."""
    client = _client(
        peer_host="127.0.0.1",
        proxy_trusted_hosts=["127.0.0.1"],
    )
    r = client.get(
        "/_region",
        headers={
            "X-Forwarded-For": UNTRUSTED_IP,
            "X-Lectorium-Region": "ru",
        },
    )
    assert r.status_code == 200
    assert r.json() == {"region": None}


def test_ru_proxy_ip_not_in_trusted_sources_drops_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same RU-proxy XFF but the env wasn't configured — the header is
    dropped, which is the CRITICAL #1 failure mode caught by this test.
    """
    _reload_settings_with(monkeypatch, sources="")  # operator forgot
    client = _client(
        peer_host="127.0.0.1",
        proxy_trusted_hosts=["127.0.0.1"],
    )
    r = client.get(
        "/_region",
        headers={
            "X-Forwarded-For": RU_PROXY_IP,
            "X-Lectorium-Region": "ru",
        },
    )
    assert r.status_code == 200
    assert r.json() == {"region": None}


def test_direct_request_from_untrusted_peer_is_dropped() -> None:
    """No middleware at all — the raw peer IS the public IP. extract_region
    must drop the header. (Defence-in-depth check: even if the edge
    misconfigures ProxyHeaders, the trust gate in _region.py still fires.)
    """
    client = _client(peer_host=UNTRUSTED_IP)
    r = client.get("/_region", headers={"X-Lectorium-Region": "ru"})
    assert r.status_code == 200
    assert r.json() == {"region": None}
