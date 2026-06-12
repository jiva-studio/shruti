"""POST /chat — SSE stream of agent events."""

from __future__ import annotations

import dataclasses
import json
import re
import uuid
from time import perf_counter
from typing import Any, AsyncIterator, Awaitable, Callable

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from lectorium_chat.api._auth import get_current_user
from lectorium_chat.api._rate_limit import raise_429
from lectorium_chat.api._region import extract_region
from lectorium_chat.api.schemas.chat import ChatRequestDto
from lectorium_chat.application.chat_turn import run_chat_turn
from lectorium_chat.application.proactive_turn import run_proactive_turn
from lectorium_chat.application.rate_limiter import _next_midnight_utc
from lectorium_chat.composition import AppDeps, get_deps
from lectorium_chat.domain.user_context import UserContext
from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)

router = APIRouter()


# OpenTelemetry trace_id: 32 lowercase hex chars, non-zero. A UUIDv4
# stripped of its hyphens fits this exactly — that's what the mobile
# client sends (the assistant ChatMessage.id minus hyphens). Validate
# the header before honouring it so junk values can't flow into the
# trace store.
_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_TRACE_ID_ZERO = "0" * 32

# Idempotency-Key shape: 8-64 chars, alphanumeric + hyphen. Anchored so
# we reject embedded whitespace / control chars / unicode that could
# wreck the Redis key. UUIDv4 (with or without hyphens), short hashes,
# and our client-minted formats all comply.
_IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


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
    x_chat_protocol_version: str | None = Header(default=None),
    idempotency_key: str | None = Header(default=None),
    x_trace_id: str | None = Header(default=None),
    user: VerifiedUser = Depends(get_current_user),
    deps: AppDeps = Depends(get_deps),
):
    _check_protocol_version(x_chat_protocol_version)
    request_id = uuid.uuid4().hex[:12]

    # Client mints an assistant ChatMessage.id (UUIDv4) before opening
    # the stream and sends its hyphenless 32-hex form as X-Trace-Id so
    # message identity == Langfuse trace identity. Score writes from a
    # later /chat/feedback POST can then reference the same id. If the
    # header is missing or malformed (legacy client), we fall back to a
    # server-minted id and just don't echo it back — the dependent UI
    # (thumbs feedback) degrades gracefully on those rows.
    client_trace_id: str | None = None
    if x_trace_id and _TRACE_ID_RE.match(x_trace_id) and x_trace_id != _TRACE_ID_ZERO:
        client_trace_id = x_trace_id
    elif x_trace_id:
        log.info("chat_x_trace_id_invalid", value=x_trace_id[:64])

    # Reject malformed Idempotency-Key shapes up-front. A junk value
    # (whitespace, control chars, unbounded length) would otherwise flow
    # straight into the Redis key and waste store slots forever.
    if idempotency_key is not None and not _IDEMPOTENCY_KEY_RE.fullmatch(idempotency_key):
        raise HTTPException(status_code=400, detail="invalid Idempotency-Key")

    # Idempotency gate — duplicate retries within the TTL window bounce
    # with 409 instead of replaying the LLM turn. Sits BEFORE the rate
    # limiter so a duplicate doesn't burn the user's daily quota.
    # Absent header means the client opts out (legacy); we just skip.
    if idempotency_key:
        # 10-minute window: longest plausible chat-turn wallclock + safety.
        acquired = await deps.idempotency_store.try_acquire(
            f"chat:{user.id}:{idempotency_key}", ttl_seconds=600,
        )
        if not acquired:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "duplicate_request",
                    "message": "Idempotency-Key already in flight or recently completed",
                },
            )

    # Everything from the acquired idempotency key down to the moment the
    # SSE stream is handed off can still fail (429 rate-limit, region
    # parsing, UserContext build). The stream's own `finally` only runs
    # once the generator is iterated, so a failure here would leak the
    # key for the full TTL and 409-block the user's retries. Release it
    # on any pre-stream exception and re-raise; the happy path leaves the
    # key held and lets the stream's finally own its lifecycle.
    try:
        # Rate-limit gate (per-day per JWT-sub + per-IP).
        ip = request.client.host if request.client else "unknown"
        rl = await deps.rate_limiter.check_and_increment(
            user.id, user.anonymous, ip, scope="chat",
            tier=user.tier, quota_id=user.quota_id,
            tier_expires_at=user.tier_expires_at,
        )
        if not rl.allowed:
            raise_429(rl, scope="chat")

        region = extract_region(request)

        structlog.contextvars.bind_contextvars(
            request_id=request_id, user_id=user.id, anonymous=user.anonymous, ip=ip,
            region=region,
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

        # Carry the verified UUID into UserContext so the application layer
        # can bind it to Langfuse `trace.user_id` without re-reading the
        # JWT or threading an extra parameter through the call chain. The
        # wire DTO (UserContextDto) intentionally does NOT carry user_id —
        # the client doesn't know its own UUID, only the JWT does.
        if body.user_context is not None:
            user_ctx = dataclasses.replace(body.user_context.to_domain(), user_id=user.id)
        else:
            user_ctx = UserContext(user_id=user.id)
    except BaseException:
        if idempotency_key:
            await deps.idempotency_store.release(f"chat:{user.id}:{idempotency_key}")
        raise

    # Effective trace id keys the turn buffer. Client-minted when present
    # (so the same id polls the result on return); a server-minted fallback
    # for legacy clients — which then simply can't resume.
    effective_trace_id = client_trace_id or uuid.uuid4().hex
    turn_started = perf_counter()

    def build_stream(
        is_cancelled: Callable[[], Awaitable[bool]],
    ) -> AsyncIterator[Any]:
        # Resume / disconnect is the runner's concern; here we only choose
        # which turn to run and thread the runner's cancel predicate in.
        if body.proactive is not None:
            return run_proactive_turn(
                body.proactive.rule_kind,
                body.proactive.rule_context,
                lang=body.lang,
                request_id=request_id,
                user_context=user_ctx,
                is_disconnected=is_cancelled,
            )
        return run_chat_turn(
            [m.model_dump() for m in body.messages],
            lang=body.lang,
            translate_citations=body.translate_citations,
            capabilities=body.capabilities,
            request_id=request_id,
            user_context=user_ctx,
            is_disconnected=is_cancelled,
            deps=deps,
            session_id=body.session_id,
            session_title=body.session_title,
            client_trace_id=client_trace_id,
            region=region,
            turn_config=(body.config.model_dump() if body.config else None),
        )

    async def finalize(had_error: bool, completed: bool) -> dict[str, Any]:
        # Turn-specific teardown (the runner owns the task / buffer / finish):
        # release the idempotency key only on a real failure (a clean turn
        # keeps it to dedup genuine duplicate sends). A bare client disconnect
        # no longer releases or refunds — the turn still completes and
        # delivers its answer to the buffer.
        if idempotency_key and had_error:
            await deps.idempotency_store.release(f"chat:{user.id}:{idempotency_key}")
        usage_current = rl.current_after
        if had_error:
            refunded = await deps.rate_limiter.refund(
                user.id, user.anonymous, ip,
                scope="chat", quota_id=user.quota_id,
            )
            if refunded is not None:
                usage_current = refunded
        log.info(
            "stage_timing",
            stage="turn_total",
            stage_ms=round((perf_counter() - turn_started) * 1000, 1),
            status="error" if had_error else ("cancelled" if not completed else "ok"),
            request_id=request_id,
            proactive=body.proactive is not None,
        )
        # Usage chip frame is part of the buffered turn so a reconnecting
        # client hydrates the chip too.
        return {
            "event": "usage",
            "data": json.dumps(
                {
                    "scope": "chat",
                    "current": usage_current,
                    "limit": rl.limit_for_scope,
                    "resets_at_epoch": int(_next_midnight_utc().timestamp()),
                },
                ensure_ascii=False,
            ),
        }

    # The turn runs DETACHED via the runner: it keeps generating after the
    # client socket drops (background / navigation) and buffers its events for
    # resume. The SSE response below is just a live view tailing the runner's
    # queue; closing it does NOT cancel the turn — only DELETE /chat/turn/{id}
    # does. The producer-task lifecycle + cancel registry live in the runner,
    # not as module globals in this route.
    queue = deps.turn_runner.start(
        effective_trace_id,
        user.id,
        stream_factory=build_stream,
        finalize=finalize,
    )

    async def event_stream() -> AsyncIterator[dict[str, Any]]:
        # Thin live view: drain the producer's queue until the sentinel or
        # until the client drops (sse-starlette stops iterating here). The
        # producer keeps running either way.
        try:
            while True:
                frame = await queue.get()
                if frame is None:
                    break
                yield frame
        finally:
            structlog.contextvars.unbind_contextvars(
                "request_id", "user_id", "anonymous", "ip", "region",
            )

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


@router.get("/chat/turn/{trace_id}")
async def get_turn(
    trace_id: str,
    user: VerifiedUser = Depends(get_current_user),
    deps: AppDeps = Depends(get_deps),
):
    """Poll a turn's buffered result by its trace id.

    A reconnecting client (came back from background / app restart) reads
    `{state}` — `running` (keep polling), `done` / `error` (replay the
    buffered SSE events to rebuild the message). 404 means the turn was
    never received OR its buffer expired (24h) OR it belongs to another
    user — we never leak existence across identities.
    """
    if not _TRACE_ID_RE.match(trace_id):
        raise HTTPException(status_code=400, detail="invalid trace id")
    blob = await deps.turn_store.get(trace_id)
    if blob is None or blob.get("user_id") != user.id:
        raise HTTPException(status_code=404, detail="turn not found")
    return {"state": blob.get("state"), "events": blob.get("events", [])}


@router.delete("/chat/turn/{trace_id}")
async def cancel_turn(
    trace_id: str,
    user: VerifiedUser = Depends(get_current_user),
    deps: AppDeps = Depends(get_deps),
):
    """Explicit Stop — really cancel the turn (vs a passive disconnect,
    which lets it finish). Cancels the producer on this replica instantly
    and sets a cross-replica Redis flag for the case it runs elsewhere."""
    if not _TRACE_ID_RE.match(trace_id):
        raise HTTPException(status_code=400, detail="invalid trace id")
    blob = await deps.turn_store.get(trace_id)
    if blob is not None and blob.get("user_id") != user.id:
        raise HTTPException(status_code=404, detail="turn not found")
    await deps.turn_runner.cancel(trace_id)
    return {"ok": True}
