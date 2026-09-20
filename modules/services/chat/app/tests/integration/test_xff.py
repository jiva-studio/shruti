"""X-Forwarded-For trust: middleware rewrites `request.client.host` only
when the connecting peer is in `trusted_proxy_cidrs`.

These tests don't need Postgres or any LLM — they exercise the uvicorn
middleware in isolation, mirroring how it is wired in `main.py`. They sit
under `tests/integration/` per the plan and used to be skipped for it;
gating is by the `needs_db` / `needs_network` markers now, and these carry
neither, so they run in the ordinary suite.

What they cover:
- Trusted peer + XFF header → endpoint sees the XFF address.
- Untrusted peer + XFF header → endpoint keeps the raw peer IP (no
  spoofing surface for direct hits to the service).
- Multi-hop XFF → middleware picks the leftmost non-trusted hop.
- Default settings actually include the docker private ranges so the
  prod wiring works out of the box.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from httpx import ASGITransport, AsyncClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from lectorium_chat.config import Settings


pytestmark = pytest.mark.asyncio


def _build_probe_app(trusted: list[str]):
    """Mirror main.py wiring: ProxyHeadersMiddleware wraps a FastAPI app.

    The probe endpoint returns the post-middleware client host so the
    test can assert exactly what `request.client.host` would be in
    `api/chat.py:110` etc."""
    app = FastAPI()

    @app.get("/whoami")
    async def whoami(request: Request) -> dict[str, str | None]:
        return {"ip": request.client.host if request.client else None}

    return ProxyHeadersMiddleware(app, trusted_hosts=trusted)


async def _probe(asgi_app, *, peer: str, xff: str | None = None) -> str | None:
    transport = ASGITransport(app=asgi_app, client=(peer, 12345))
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        headers = {"X-Forwarded-For": xff} if xff else {}
        r = await ac.get("/whoami", headers=headers)
        return r.json()["ip"]


async def test_trusted_peer_uses_xff_address() -> None:
    """Peer IP inside the trusted list → request.client.host = XFF value."""
    app = _build_probe_app(trusted=["10.0.0.0/8"])
    ip = await _probe(app, peer="10.0.0.7", xff="1.2.3.4")
    assert ip == "1.2.3.4"


async def test_untrusted_peer_keeps_peer_ip() -> None:
    """Peer IP outside trusted list → XFF header is ignored. This is the
    anti-spoofing property — a direct hit from the open internet can't
    pretend to be any IP it likes."""
    app = _build_probe_app(trusted=["10.0.0.0/8"])
    ip = await _probe(app, peer="203.0.113.50", xff="1.2.3.4")
    assert ip == "203.0.113.50"


async def test_multi_hop_xff_picks_leftmost_untrusted() -> None:
    """`X-Forwarded-For: <client>, <proxy1>, <proxy2>` from a trusted
    edge — middleware walks right-to-left through the trusted hops and
    returns the first untrusted one (= the real client)."""
    app = _build_probe_app(trusted=["10.0.0.0/8", "192.168.0.0/16"])
    # 1.2.3.4 = real client; 10.0.0.7 = inner proxy; 192.168.1.5 = edge
    # proxy (the peer we're directly connected from).
    ip = await _probe(
        app,
        peer="192.168.1.5",
        xff="1.2.3.4, 10.0.0.7, 192.168.1.5",
    )
    assert ip == "1.2.3.4"


async def test_no_xff_header_keeps_peer_ip() -> None:
    """No header → unchanged scope, even from a trusted source."""
    app = _build_probe_app(trusted=["10.0.0.0/8"])
    ip = await _probe(app, peer="10.0.0.7", xff=None)
    assert ip == "10.0.0.7"


async def test_default_settings_trust_docker_private_ranges() -> None:
    """`Settings.trusted_proxy_cidrs` default covers RFC1918 docker
    networks so the prod compose wiring works without any env override."""
    cidrs = Settings().trusted_proxy_cidrs
    assert "10.0.0.0/8" in cidrs
    assert "172.16.0.0/12" in cidrs
    assert "192.168.0.0/16" in cidrs


async def test_default_settings_used_as_trusted_hosts() -> None:
    """End-to-end with the actual default CIDR list: docker-bridge peer
    (172.x) sees its XFF honoured."""
    app = _build_probe_app(trusted=Settings().trusted_proxy_cidrs)
    ip = await _probe(app, peer="172.18.0.1", xff="198.51.100.7")
    assert ip == "198.51.100.7"


async def test_trusted_proxy_cidrs_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    """Comma-separated env-var form parses into a list (pydantic-settings
    JSON-decode is bypassed via `NoDecode`)."""
    monkeypatch.setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1, 10.5.0.0/16 , 192.0.2.1")
    s = Settings()
    assert s.trusted_proxy_cidrs == ["127.0.0.1", "10.5.0.0/16", "192.0.2.1"]
