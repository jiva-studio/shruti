"""POST /chat — SSE stream of agent events."""

from __future__ import annotations

import json
import uuid
from time import perf_counter
from typing import Any, AsyncIterator

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from shruti_chat.api._auth import get_current_user
from shruti_chat.api.schemas.chat import ChatRequestDto
from shruti_chat.application.chat_turn import run_chat_turn
from shruti_chat.application.proactive_turn import run_proactive_turn
from shruti_chat.composition import AppDeps, get_deps
from shruti_chat.config import get_settings
from shruti_chat.infra.auth.jwt_verifier import VerifiedUser
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)

router = APIRouter()


def _check_app_token(token: str | None) -> None:
    expected = get_settings().app_shared_token
    if not token or token != expected:
        raise HTTPException(status_code=401, detail="invalid app token")


_SUPPORTED_PROTOCOL_VERSIONS = ("1",)


def _check_protocol_version(version: str | None) -> None:
    """Enforce explicit SSE protocol handshake.

    Mobile clients MUST send `X-Chat-Protocol-Version: 1`. Rejecting
    unversioned requests up-front means we never silently downgrade
    to an older event shape — the next breaking change just adds "2"
    to the supported set and serves both.
    """
    if version not in _SUPPORTED_PROTOCOL_VERSIONS:
        raise HTTPException(
            status_code=426,
            detail={
                "code": "protocol_version_required",
                "supported": list(_SUPPORTED_PROTOCOL_VERSIONS),
                "received": version,
            },
            headers={"X-Chat-Supported-Versions": ",".join(_SUPPORTED_PROTOCOL_VERSIONS)},
        )


@router.post("/chat")
async def chat(
    request: Request,
    body: ChatRequestDto,
    x_app_token: str | None = Header(default=None),
    x_chat_protocol_version: str | None = Header(default=None),
    idempotency_key: str | None = Header(default=None),
    user: VerifiedUser = Depends(get_current_user),
    deps: AppDeps = Depends(get_deps),
):
    _check_app_token(x_app_token)
    _check_protocol_version(x_chat_protocol_version)
    request_id = uuid.uuid4().hex[:12]

    # Rate-limit gate (per-day per JWT-sub + per-IP).
    ip = request.client.host if request.client else "unknown"
    rl = await deps.rate_limiter.check_and_increment(
        user.id, user.anonymous, ip, scope="chat",
    )
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
        request_id=request_id, user_id=user.id, anonymous=user.anonymous, ip=ip,
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
        proactive_rule=body.proactive.rule_kind if body.proactive else None,
    )

    user_ctx = body.user_context.to_domain() if body.user_context else None

    async def event_stream() -> AsyncIterator[dict[str, Any]]:
        turn_started = perf_counter()
        try:
            if body.proactive is not None:
                # Proactive turn — rule-specific prompt swap. Same tool
                # registry, same SSE response shape; the client doesn't
                # render the stream live, it collects it into a single
                # `chat_messages.body_md` row for later display.
                stream = run_proactive_turn(
                    body.proactive.rule_kind,
                    body.proactive.rule_context,
                    lang=body.lang,
                    request_id=request_id,
                    user_context=user_ctx,
                    is_disconnected=request.is_disconnected,
                )
            else:
                stream = run_chat_turn(
                    [m.model_dump() for m in body.messages],
                    lang=body.lang,
                    request_id=request_id,
                    user_context=user_ctx,
                    is_disconnected=request.is_disconnected,
                    deps=deps,
                )
            async for ev in stream:
                yield {
                    "event": ev.type,
                    "data": json.dumps(ev.data, ensure_ascii=False),
                }
        finally:
            log.info(
                "stage_timing",
                stage="turn_total",
                stage_ms=round((perf_counter() - turn_started) * 1000, 1),
                status="ok",
                request_id=request_id,
                proactive=body.proactive is not None,
            )
            structlog.contextvars.unbind_contextvars("request_id", "user_id", "anonymous", "ip")

    return EventSourceResponse(
        event_stream(),
        media_type="text/event-stream",
        # Disable nginx/proxy buffering so deltas reach the client
        # one-by-one rather than batched into 4KB blocks. Without this
        # header SSE looks "frozen" for ~500ms while the proxy fills
        # its buffer.
        headers={"X-Accel-Buffering": "no"},
        # 15s heartbeat keeps mobile NAT entries warm; sse-starlette
        # emits `: keepalive` comment frames at this interval. (This
        # is the default but pin it so future library updates don't
        # surprise us.)
        ping=15,
    )
