"""POST /chat — SSE stream of agent events."""

from __future__ import annotations

import json
import uuid
from typing import Any, AsyncIterator

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from shruti_chat.api.schemas.chat import ChatRequestDto
from shruti_chat.application.chat_turn import run_chat_turn
from shruti_chat.composition import AppDeps, get_deps
from shruti_chat.config import get_settings
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)

router = APIRouter()


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
    body: ChatRequestDto,
    x_app_token: str | None = Header(default=None),
    x_device_id: str | None = Header(default=None),
    idempotency_key: str | None = Header(default=None),
    deps: AppDeps = Depends(get_deps),
):
    _check_app_token(x_app_token)
    device_id = _check_device_id(x_device_id)
    request_id = uuid.uuid4().hex[:12]

    # Rate-limit gate (per-day per device + per-IP)
    ip = request.client.host if request.client else "unknown"
    rl = await deps.rate_limiter.check_and_increment(device_id, ip)
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
        # `Idempotency-Key` is logged for observability only — once
        # Redis-backed dedup lands (followup PR) the same key will key
        # the per-request reply cache. For now its presence tells us
        # whether the mobile client is sending it after a retry, which
        # is the dataset that decides whether dedup is worth building.
        idempotency_key=idempotency_key,
    )

    user_ctx = body.user_context.to_domain() if body.user_context else None

    async def event_stream() -> AsyncIterator[dict[str, Any]]:
        try:
            async for ev in run_chat_turn(
                [m.model_dump() for m in body.messages],
                lang=body.lang,
                request_id=request_id,
                user_context=user_ctx,
                is_disconnected=request.is_disconnected,
            ):
                yield {
                    "event": ev.type,
                    "data": json.dumps(ev.data, ensure_ascii=False),
                }
        finally:
            structlog.contextvars.unbind_contextvars("request_id", "device_id", "ip")

    return EventSourceResponse(event_stream(), media_type="text/event-stream")
