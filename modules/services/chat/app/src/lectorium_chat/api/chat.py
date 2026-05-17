"""POST /chat — SSE stream of agent events."""

from __future__ import annotations

import json
import uuid
from typing import Any, AsyncIterator, Literal

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from lectorium_chat.agent.loop import run_agent
from lectorium_chat.config import get_settings
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.ratelimit import check_and_increment

log = get_logger(__name__)

router = APIRouter()


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class UserContextTrack(BaseModel):
    track_id: str
    position_ms: int | None = None
    percent: float | None = None
    last_played_at: str | None = None
    completed: bool = False


class UserNote(BaseModel):
    track_id: str | None = None
    time_start_ms: int | None = None
    time_end_ms: int | None = None
    text: str
    created_at: str | None = None


class FocusFragment(BaseModel):
    """User just tapped a specific span (e.g. an outline chapter) and the
    next message implicitly targets it. The agent should pull
    `get_transcript_window` around this range instead of guessing."""

    track_id: str
    start_ms: int
    end_ms: int
    title: str | None = None


class UserContext(BaseModel):
    """Snapshot of on-device state sent with each /chat request.

    `now` and `tz_offset_minutes` let temporal queries ("yesterday",
    "a week ago") resolve against the user's wall clock, not the
    server's UTC. `last_played_at` on each track / note is then
    comparable to `now` for relative-time filtering.
    """

    current_track_id: str | None = None
    now: str | None = None  # ISO-8601 with offset, device local time
    tz_offset_minutes: int | None = None
    recent_tracks: list[UserContextTrack] = Field(default_factory=list, max_length=20)
    in_progress: list[UserContextTrack] = Field(default_factory=list, max_length=10)
    recent_notes: list[UserNote] = Field(default_factory=list, max_length=30)
    focus: FocusFragment | None = None


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)
    lang: Literal["ru", "en"] = "ru"
    user_context: UserContext | None = None


def _check_app_token(token: str | None) -> None:
    expected = get_settings().app_shared_token
    if not token or token != expected:
        raise HTTPException(status_code=401, detail="invalid app token")


def _check_device_id(device_id: str | None) -> str:
    if not device_id:
        raise HTTPException(status_code=400, detail="missing X-Device-Id header")
    return device_id


@router.post("/chat")
async def chat(
    request: Request,
    body: ChatRequest,
    x_app_token: str | None = Header(default=None),
    x_device_id: str | None = Header(default=None),
):
    _check_app_token(x_app_token)
    device_id = _check_device_id(x_device_id)
    request_id = uuid.uuid4().hex[:12]

    # Rate-limit gate (per-day per device + per-IP)
    ip = request.client.host if request.client else "unknown"
    rl = await check_and_increment(device_id, ip)
    if not rl.allowed:
        raise HTTPException(
            status_code=429,
            detail={
                "code": rl.code,
                "limit": rl.limit,
                "current": rl.current,
                "key_type": rl.key_type,
            },
            headers={"Retry-After": str(rl.retry_after or 60)},
        )

    structlog.contextvars.bind_contextvars(
        request_id=request_id, device_id=device_id, ip=ip,
    )
    log.info(
        "chat_request",
        message_count=len(body.messages),
        lang=body.lang,
    )

    async def event_stream() -> AsyncIterator[dict[str, Any]]:
        try:
            async for ev in run_agent(
                [m.model_dump() for m in body.messages],
                lang=body.lang,
                request_id=request_id,
                user_context=body.user_context,
            ):
                yield {"event": ev.type, "data": json.dumps(ev.data, ensure_ascii=False)}
        finally:
            structlog.contextvars.unbind_contextvars("request_id", "device_id", "ip")

    return EventSourceResponse(event_stream(), media_type="text/event-stream")
