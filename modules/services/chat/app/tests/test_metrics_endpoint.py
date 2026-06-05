"""`/metrics` is mounted and serves the registered counters.

Lifespan-free: importing `main` builds the FastAPI `app` (no DB/Redis
needed for module import), and the Prometheus exposition is read
straight from the default REGISTRY — which is exactly what the mounted
`make_asgi_app()` serves. This guards against the endpoint silently
losing its mount or a counter being dropped from the default registry.
"""

from __future__ import annotations

from prometheus_client import generate_latest
from starlette.routing import Mount

# Import the counters so they're registered before we scrape, regardless
# of import order under pytest.
import lectorium_chat.observability.metrics  # noqa: F401
from lectorium_chat.main import app


def test_metrics_endpoint_is_mounted() -> None:
    assert any(
        isinstance(r, Mount) and r.path == "/metrics" for r in app.routes
    ), "/metrics sub-app is not mounted on the FastAPI app"


def test_metrics_registry_exposes_chat_counters() -> None:
    body = generate_latest().decode()
    # The two counters defined in observability/metrics.py must render.
    assert "lectorium_chat_rate_limit_hits_total" in body
    assert "lectorium_chat_rate_limit_redis_unavailable_total" in body
