"""POST /chat/feedback — user feedback on an assistant message.

Mobile thumbs up/down (with optional category + free-text on thumbs-
down) is turned into 1-3 Langfuse scores attached to the trace id the
mobile received on the SSE `meta` event. Scores use deterministic
`{trace_id}:{name}` ids so repeated flips upsert in place — see plan
file `image-1-langfuse-unified-prism.md` for the full state machine.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from lectorium_chat.api._auth import get_current_user
from lectorium_chat.api._rate_limit import raise_429
from lectorium_chat.api._region import extract_region
from lectorium_chat.composition import AppDeps, get_deps
from lectorium_chat.infra.auth.jwt_verifier import VerifiedUser
from lectorium_chat.observability.langfuse_client import get_langfuse
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)
router = APIRouter()


class FeedbackValue(str, Enum):
    UP = "up"
    DOWN = "down"


class FeedbackCategory(str, Enum):
    OFF_TOPIC = "off_topic"
    NO_RESULTS = "no_results"
    BAD_CITATIONS = "bad_citations"
    WRONG_LANGUAGE = "wrong_language"
    FACTUALLY_WRONG = "factually_wrong"
    OTHER = "other"


class FeedbackIn(BaseModel):
    # Langfuse trace id — 32-hex uuid4 in current code path. Pattern
    # stays permissive (alnum + dash + underscore) so a future change to
    # the trace-id format doesn't break the schema.
    trace_id: str = Field(..., min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    value: FeedbackValue
    # Only meaningful for value=DOWN. Server writes the category score
    # whenever it's provided (even if the user later flipped to UP) —
    # the Langfuse SDK has no delete, so historical categories stay as
    # documented in the plan file.
    category: FeedbackCategory | None = None
    comment: str | None = Field(default=None, max_length=500)


class FeedbackOut(BaseModel):
    ok: bool = True


def _create_score(langfuse: Any, **kwargs: Any) -> None:
    """Wrap create_score so a Langfuse outage doesn't bubble up to the
    client. Feedback is best-effort observability — if it fails we log
    and return 200 anyway so the mobile UI doesn't surface a misleading
    error to the user."""
    try:
        langfuse.create_score(**kwargs)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "feedback_score_create_failed",
            name=kwargs.get("name"),
            trace_id=kwargs.get("trace_id"),
            error=str(exc),
        )


@router.post("/chat/feedback", response_model=FeedbackOut)
async def post_feedback(
    request: Request,
    payload: FeedbackIn,
    user: VerifiedUser = Depends(get_current_user),
    deps: AppDeps = Depends(get_deps),
) -> FeedbackOut:
    ip = request.client.host if request.client else "unknown"
    rl = await deps.rate_limiter.check_and_increment(
        user.id, user.anonymous, ip, scope="feedback",
        tier=user.tier, quota_id=user.quota_id,
        tier_expires_at=user.tier_expires_at,
    )
    if not rl.allowed:
        raise_429(rl, scope="feedback")

    langfuse = get_langfuse()
    if langfuse is None:
        # Singleton not initialised (missing env / force-fallback /
        # SDK import failure). Accept the request silently — observability
        # being off doesn't justify a 5xx to the mobile UI.
        log.info(
            "feedback_skipped_no_langfuse",
            trace_id=payload.trace_id,
            value=payload.value.value,
        )
        return FeedbackOut()

    trace_id = payload.trace_id
    is_up = payload.value is FeedbackValue.UP

    _create_score(
        langfuse,
        name="user_feedback",
        value=1 if is_up else 0,
        trace_id=trace_id,
        data_type="BOOLEAN",
        score_id=f"{trace_id}:user_feedback",
    )
    if not is_up and payload.category is not None:
        _create_score(
            langfuse,
            name="user_feedback_category",
            value=payload.category.value,
            trace_id=trace_id,
            data_type="CATEGORICAL",
            score_id=f"{trace_id}:user_feedback_category",
        )
    region = extract_region(request)
    # RU traffic: free-text feedback never leaves the trust boundary.
    # The boolean and category scores still ship because they're
    # aggregate-only and carry no user-authored prose.
    if not is_up and payload.comment and region != "ru":
        _create_score(
            langfuse,
            name="user_feedback_text",
            value=payload.comment[:500],
            trace_id=trace_id,
            data_type="TEXT",
            score_id=f"{trace_id}:user_feedback_text",
        )

    log.info(
        "feedback_recorded",
        trace_id=trace_id,
        value=payload.value.value,
        category=payload.category.value if payload.category else None,
        has_comment=bool(payload.comment),
        user_id=user.id,
        region=region,
    )
    return FeedbackOut()
