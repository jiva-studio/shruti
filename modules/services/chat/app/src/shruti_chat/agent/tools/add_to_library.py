"""Action-tool: add an external lecture to the user's personal library.

Same contract as the `propose_*` action-tools (mint an `action_id`, emit an
SSE `action` side-event, return the id for the inline marker) with ONE extra
server-side effect: it publishes an `ingest.request` to the broker so the
ingest worker (#1224) actually fetches + imports the lecture.

Called by the deterministic `add_to_library_worker` (NOT the ReAct loop):
the worker has already PRO-gated the user and chosen the candidate, so this
is plain code, not a model judgement — mirroring `action_worker` /
`find_tracks_worker`. The publish is best-effort: a down/absent broker
(#1224 not deployed yet) still emits the card so the client can retry the
tap later; the SSE event is what the UI renders.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.tools.actions import YieldEvent, _new_action_id, _noop_yield
from shruti_chat.infra.broker.publisher import (
    IngestRequestPublisher,
    NoopIngestPublisher,
)
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


async def add_to_library_publish(
    *,
    url: str,
    user_id: str,
    jwt: str,
    title: str = "",
    thumbnail: str = "",
    author: str = "",
    publisher: IngestRequestPublisher | None = None,
    yield_event: YieldEvent = _noop_yield,
) -> dict[str, Any]:
    """Publish `ingest.request` for `url` and emit the `added_to_library`
    action card. Returns `{ok, kind, action_id, published}`; `error` when the
    inputs are unusable (no url / no identity)."""
    u = (url or "").strip()
    if not u:
        return {"error": "url_required"}
    if not user_id or not jwt:
        # Can't attribute the ingest to a user — refuse rather than publish a
        # headless request the ingest worker would drop.
        return {"error": "identity_required"}

    pub = publisher or NoopIngestPublisher()
    published = await pub.publish(user_id=user_id, url=u, jwt=jwt)

    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "added_to_library",
            "id": action_id,
            "payload": {
                "url": u,
                "title": title,
                "author": author,
                "thumbnail": thumbnail,
                # Tells the client whether the ingest was actually enqueued
                # (broker up) or is a pending retry (broker absent — #1224).
                "queued": published,
            },
        },
    )
    log.info(
        "add_to_library_published",
        user_id=user_id, url=u, published=published, action_id=action_id,
    )
    return {
        "ok": True,
        "kind": "added_to_library",
        "action_id": action_id,
        "published": published,
    }
