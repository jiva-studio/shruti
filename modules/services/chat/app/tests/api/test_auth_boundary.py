"""401 at the real HTTP boundary — no `dependency_overrides`.

Every other authed-route test replaces `get_current_user` with a lambda, so
the dependency's body never runs under pytest: a token check that stopped
rejecting anything would leave the whole suite green. Here the real app is
served over ASGI with a real `JwtVerifier` on `app.state.deps`, and the only
thing faked is the signing key.

`test_every_non_public_route_requires_a_user` is the one that catches the
regression that matters: a new endpoint shipping without `get_current_user`.
The 401 cases below are derived from the route table for the same reason —
add an authed route and it is exercised without touching this file.
"""

from __future__ import annotations

import re

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import routing
from fastapi.dependencies.models import Dependant
from httpx import ASGITransport, AsyncClient

from lectorium_chat.api._auth import get_current_user
from lectorium_chat.infra.auth.jwt_verifier import JwtVerifier
from lectorium_chat.main import app
from tests.conftest import build_deps

# Unauthenticated by design: health probes and the service banner. Adding a
# path here is the deliberate act the route walk below forces you to make.
_PUBLIC_PATHS = frozenset({"/", "/healthz", "/readyz", "/version", "/status"})

# Guarded by the shared app token instead of a user JWT (see `_check_token`),
# because the callers are the cleanup worker and operators, not clients.
_APP_TOKEN_PATHS = frozenset({"/reindex", "/internal/purge"})


def _keypair() -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    pub = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return priv, pub


def _sign(priv: str) -> str:
    return pyjwt.encode(
        {"sub": "u1", "anonymous": False, "aud": "chat", "exp": 9999999999},
        priv,
        algorithm="RS256",
        headers={"kid": "v1"},
    )


def _depends_on(dependant: Dependant | None, fn: object) -> bool:
    if dependant is None:
        return False
    return any(d.call is fn or _depends_on(d, fn) for d in dependant.dependencies)


def _endpoints() -> list:
    """The effective route table, flattened.

    FastAPI 0.141 replaced the eager route list with lazy `_IncludedRouter`
    proxies, so an included router's endpoints are no longer reachable by
    walking `app.routes` for `APIRoute` instances — `iter_route_contexts` is
    what `openapi()` itself walks. The fallback keeps this working on the
    older flat layout. Entries without a `dependant` (docs routes, the
    `/metrics` mount) are Starlette-level and carry no dependencies.
    """
    iter_contexts = getattr(routing, "iter_route_contexts", None)
    contexts = (
        list(iter_contexts(app.routes))
        if iter_contexts is not None
        else [r for r in app.routes if isinstance(r, routing.APIRoute)]
    )
    return [c for c in contexts if getattr(c, "dependant", None) is not None]


def _routes_requiring_user() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for route in _endpoints():
        if not _depends_on(route.dependant, get_current_user):
            continue
        path = re.sub(r"\{[^}]+\}", "0" * 32, route.path)
        for method in sorted((route.methods or set()) - {"HEAD", "OPTIONS"}):
            out.append((method, path))
    return out


AUTHED_ROUTES = _routes_requiring_user()

# Four ways a request can fail to carry a usable identity. The foreign-key
# token is the interesting one: well-formed, unexpired, right `kid`, right
# audience — only the signature is wrong.
REJECTED_HEADERS = [
    pytest.param("none", id="no-authorization-header"),
    pytest.param("basic", id="basic-auth"),
    pytest.param("garbage", id="bearer-garbage"),
    pytest.param("foreign", id="foreign-key-signature"),
]


@pytest.fixture(scope="module")
def keys() -> dict[str, tuple[str, str]]:
    return {"trusted": _keypair(), "foreign": _keypair()}


@pytest.fixture
async def client(keys):
    """The real `main.app`, with deps carrying a real verifier.

    `get_deps` reads `app.state.deps`, which lifespan normally fills; we set
    it directly (that is the seam `composition.py` documents) and restore the
    previous value so the module-level app is left as we found it.
    """
    _, trusted_pub = keys["trusted"]
    previous = getattr(app.state, "deps", None)
    app.state.deps = build_deps(jwt_verifier=JwtVerifier(trusted_pub))
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    if previous is None:
        del app.state.deps
    else:
        app.state.deps = previous


def _headers(case: str, keys) -> dict[str, str]:
    if case == "none":
        return {}
    if case == "basic":
        return {"Authorization": "Basic dXNlcjpwYXNzd29yZA=="}
    if case == "garbage":
        return {"Authorization": "Bearer garbage"}
    return {"Authorization": f"Bearer {_sign(keys['foreign'][0])}"}


def test_route_table_is_not_empty() -> None:
    """Guards the derivation itself — an empty list would make every
    parametrised case below vanish silently instead of failing."""
    assert {
        ("POST", "/chat"),
        ("POST", "/title"),
        ("POST", "/questions"),
        ("POST", "/chat/feedback"),
        ("GET", "/chat/turn/" + "0" * 32),
        ("DELETE", "/chat/turn/" + "0" * 32),
    } <= set(AUTHED_ROUTES)


@pytest.mark.parametrize("case", REJECTED_HEADERS)
@pytest.mark.parametrize(
    "method,path", AUTHED_ROUTES, ids=[f"{m} {p}" for m, p in AUTHED_ROUTES]
)
async def test_authed_route_rejects_bad_credentials(
    client, keys, method: str, path: str, case: str
) -> None:
    resp = await client.request(method, path, headers=_headers(case, keys), json={})
    assert resp.status_code == 401, f"{method} {path} [{case}] → {resp.status_code}"


@pytest.mark.parametrize(
    "method,path", AUTHED_ROUTES, ids=[f"{m} {p}" for m, p in AUTHED_ROUTES]
)
async def test_valid_token_passes_the_auth_gate(
    client, keys, method: str, path: str
) -> None:
    """Positive control. Without it the assertions above would still pass if
    every route 401'd for some unrelated reason. The body is deliberately
    empty, so what comes back is a 4xx from validation or the handler — the
    only thing asserted is that it is no longer 401."""
    token = _sign(keys["trusted"][0])
    resp = await client.request(
        method, path, headers={"Authorization": f"Bearer {token}"}, json={}
    )
    assert resp.status_code != 401


def test_every_non_public_route_requires_a_user() -> None:
    for route in _endpoints():
        if route.path in _PUBLIC_PATHS or route.path in _APP_TOKEN_PATHS:
            continue
        assert _depends_on(route.dependant, get_current_user), (
            f"{sorted(route.methods or [])} {route.path} has no auth dependency — "
            "add it, or add the path to _PUBLIC_PATHS deliberately"
        )


def test_public_allowlist_has_no_stale_entries() -> None:
    """A path that no longer exists must not keep silently excusing itself."""
    mounted = {r.path for r in _endpoints()}
    assert (_PUBLIC_PATHS | _APP_TOKEN_PATHS) <= mounted


@pytest.mark.parametrize("path", sorted(_APP_TOKEN_PATHS))
async def test_app_token_routes_reject_a_missing_token(client, path: str) -> None:
    resp = await client.post(path, json={"user_id": "u1"})
    assert resp.status_code == 401
