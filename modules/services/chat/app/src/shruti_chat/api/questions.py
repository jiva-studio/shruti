"""POST /questions — generate 3-4 short discussion questions for a focus fragment.

Called by the mobile client right after the user taps the Sadhu icon on
a transcript selection: the app shows a focus card with the quoted text
and then awaits these questions to render as suggestion chips above the
input bar. Fire-and-forget — on LLM failure the response is an empty
list and the client just renders no chips (no toast, no retry).

Sister endpoint to `/title` — same shape, same rate-limit pattern,
different prompt. Both go through `agent.oneshot.run_oneshot`.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Header, HTTPException, Request  # noqa: F401
from pydantic import BaseModel, Field

from shruti_chat.agent.oneshot import run_oneshot
from shruti_chat.api._auth import get_current_user
from shruti_chat.api._rate_limit import raise_429
from shruti_chat.composition import AppDeps, get_deps
from shruti_chat.config import get_settings
from shruti_chat.infra.auth.jwt_verifier import VerifiedUser
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

router = APIRouter()


class QuestionsFocus(BaseModel):
    track_id: str = Field(alias="trackId")
    start_ms: int = Field(alias="startMs", ge=0)
    end_ms: int = Field(alias="endMs", ge=0)
    text: str = Field(min_length=1, max_length=4000)
    track_title: str | None = Field(default=None, alias="trackTitle")
    author_name: str | None = Field(default=None, alias="authorName")
    date: str | None = None
    location: str | None = None

    model_config = {"populate_by_name": True}


class QuestionsRequest(BaseModel):
    focus: QuestionsFocus
    # Any UI locale (uk / sr / hi / …) — the client sends its current UI
    # language. We only carry ru/en prompts; `_SYSTEM.get(lang, _SYSTEM["en"])`
    # below serves English to every other locale. A `Literal["ru","en"]` here
    # would 422 every other client and make that English fallback dead code.
    lang: str = "en"


class QuestionsResponse(BaseModel):
    # Empty list is a valid response — the client treats it as "no chips
    # to show" and degrades silently. Failures on the server (LLM down,
    # parse error, quota exhausted on the model side) all collapse to
    # `[]` rather than 5xx, because chips are an enhancement, not a hard
    # requirement of the chat flow.
    questions: list[str] = []


_SYSTEM = {
    "ru": (
        "Ты помощник, который предлагает вопросы для обсуждения "
        "фрагмента лекции по ведической философии. Сформулируй 3-4 "
        "коротких вопроса (до 80 символов каждый), которые мог бы "
        "задать слушатель, чтобы глубже разобраться в этом фрагменте.\n\n"
        "Требования к формату:\n"
        "- по одному вопросу на строку\n"
        "- без нумерации, без маркеров списка, без кавычек\n"
        "- без вступительных или заключительных слов\n"
        "- вопросы заканчиваются знаком '?'\n\n"
        "Требования к содержанию:\n"
        "- содержательные, побуждающие к размышлению\n"
        "- разные по углу зрения (не варианты одного вопроса)\n"
        "- опирайся на конкретные слова и идеи фрагмента\n"
        "- не повторяй формулировки самого фрагмента"
    ),
    "en": (
        "You are an assistant that proposes discussion questions about "
        "a fragment of a Vedic philosophy lecture. Generate 3-4 short "
        "questions (up to 80 characters each) that a listener might ask "
        "to engage more deeply with this fragment.\n\n"
        "Format:\n"
        "- one question per line\n"
        "- no numbering, no bullet markers, no quotes\n"
        "- no preamble or closing line\n"
        "- each question ends with '?'\n\n"
        "Content:\n"
        "- substantive, thought-provoking\n"
        "- different angles (not variants of the same question)\n"
        "- grounded in the specific words and ideas of the fragment\n"
        "- do not paraphrase the fragment itself"
    ),
}


def _format_user_prompt(focus: QuestionsFocus, lang: str) -> str:
    """Assemble the user-side prompt with optional bibliographic context."""
    lines: list[str] = []
    meta_bits: list[str] = []
    if focus.track_title:
        meta_bits.append(focus.track_title)
    if focus.author_name:
        meta_bits.append(focus.author_name)
    if focus.date:
        meta_bits.append(focus.date)
    if focus.location:
        meta_bits.append(focus.location)
    if meta_bits:
        prefix = "Лекция" if lang == "ru" else "Lecture"
        lines.append(f"{prefix}: {', '.join(meta_bits)}")
    range_label = _format_range(focus.start_ms, focus.end_ms)
    fragment_label = "Фрагмент" if lang == "ru" else "Fragment"
    lines.append(f"{fragment_label} [{range_label}]:")
    lines.append(focus.text.strip())
    return "\n".join(lines)


def _format_range(start_ms: int, end_ms: int) -> str:
    def fmt(ms: int) -> str:
        total = max(0, ms // 1000)
        return f"{total // 60:02d}:{total % 60:02d}"

    return f"{fmt(start_ms)}–{fmt(end_ms)}"


_LIST_MARKER_RE = re.compile(r"^[\s\-\*•]*(?:\d+[\.\)]\s*)?")
_TRIM_QUOTES = ("\"", "«", "»", "“", "”", "'", "`")


def _parse_questions(raw: str, *, max_count: int = 4) -> list[str]:
    """Split LLM text into individual question lines.

    Conservative parsing: strip list markers, surrounding quotes, drop
    duplicates and lines that don't look question-shaped. Falls back to
    an empty list on degenerate output (one paragraph, no newlines, etc.).
    """
    out: list[str] = []
    seen: set[str] = set()
    for raw_line in raw.splitlines():
        line = _LIST_MARKER_RE.sub("", raw_line).strip()
        for q in _TRIM_QUOTES:
            if line.startswith(q):
                line = line[len(q):]
            if line.endswith(q):
                line = line[: -len(q)]
        line = line.strip()
        if not line:
            continue
        # A "question" without a question mark usually means the model
        # echoed a preamble line ("Here are some questions:"); drop it.
        if "?" not in line:
            continue
        if len(line) > 200:
            continue
        key = line.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(line)
        if len(out) >= max_count:
            break
    return out


@router.post("/questions", response_model=QuestionsResponse)
async def questions(
    request: Request,
    body: QuestionsRequest,
    idempotency_key: str | None = Header(default=None),
    user: VerifiedUser = Depends(get_current_user),
    deps: AppDeps = Depends(get_deps),
) -> QuestionsResponse:
    settings = get_settings()
    if idempotency_key:
        log.info(
            "questions_request",
            user_id=user.id,
            idempotency_key=idempotency_key,
        )

    # Separate quota bucket — same rationale as /title (see config.py
    # comments). Cheaper per call than /chat but a misbehaving client
    # could fire one per selection drag.
    ip = request.client.host if request.client else "unknown"
    rl = await deps.rate_limiter.check_and_increment(
        user.id, user.anonymous, ip,
        scope="questions", tier=user.tier, quota_id=user.quota_id,
        tier_expires_at=user.tier_expires_at,
    )
    if not rl.allowed:
        raise_429(rl, scope="questions")

    sys_msg = _SYSTEM.get(body.lang, _SYSTEM["en"])
    user_msg = _format_user_prompt(body.focus, body.lang)

    raw = await run_oneshot(
        model=settings.llm_cheap,  # same cheap one-shot model as /title
        system_prompt=sys_msg,
        user_prompt=user_msg,
        # Some variety — questions should differ on retry, otherwise the
        # user sees the same chips every time they reopen the same
        # fragment. 0.6 strikes a balance against incoherent picks.
        temperature=0.6,
        # 4 questions × ~80 chars + newlines ≈ 350 tokens with headroom.
        max_tokens=400,
        log_label="questions",
    )
    if raw is None:
        return QuestionsResponse(questions=[])

    parsed = _parse_questions(raw)
    if not parsed:
        log.warning("questions_llm_unparseable", raw_len=len(raw))
    return QuestionsResponse(questions=parsed)
