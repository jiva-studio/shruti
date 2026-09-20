"""A stand-in for the chat service's metrics surface, for the e2e scrape test.

The only thing that has to be faithful here is the shape of the endpoint, and
the shape is the whole bug this test exists for: chat does not serve /metrics
from a route, it mounts the Prometheus ASGI app as a SUB-APP —

    modules/services/chat/app/src/lectorium_chat/main.py
        app.mount("/metrics", make_asgi_app())

— and a Starlette Mount answers the bare `/metrics` with a 307 to `/metrics/`.
A proxy that rewrites to `/metrics` therefore bounces the scraper back through
the front door on a path that does not match, and Prometheus records a 404
while every static config check still passes. Reproducing that needs real
Starlette routing, so this imports the real thing rather than faking the status
codes with http.server.

`/v1/chat` stands in for the service's actual API, which must stay unreachable
through the proxy — the containment half of the test asserts it 404s.
"""

from fastapi import FastAPI
from prometheus_client import Gauge, make_asgi_app

app = FastAPI()

# Registered at import, exactly like the real ones in observability/metrics.py,
# so "series present on every scrape of a live chat" holds here too — that is
# the assumption the NoData alert states in rules.yml rest on.
turns_in_flight = Gauge(
    "lectorium_chat_turns_in_flight",
    "Chat turns currently being processed",
)
turns_in_flight.set(3)

db_pool_waiters = Gauge(
    "lectorium_chat_db_pool_waiters",
    "Coroutines waiting for a free pool connection",
)
db_pool_waiters.set(0)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/v1/chat")
def private_api():
    """Stands in for chat's real API. Must never be reachable via the proxy."""
    return {"leaked": "the metrics proxy exposed a non-metrics route"}


app.mount("/metrics", make_asgi_app())
