"""Decide the language this turn is answered in.

Two halves, both cheap:

- `detect_reply_language` — one small structured-output call on the CURRENT
  message alone. It answers both "did the user ask for a language" and "what
  language is this written in"; the first has to be checked on every message
  or a change request is never noticed, which is why this is not gated on
  "we already know the language".
- `remembered_reply_language` — reads back what an earlier turn settled on,
  off the assistant message the client replayed. That is what makes the
  switch survive past the 20-message history window and an app restart,
  instead of being re-derived from the conversation every turn.

History is deliberately NOT fed to the detector: an earlier request is
remembered as a value, not re-discovered by re-reading the dialogue.

Deterministic (temperature 0 inside `structured_output`), so the call is
memoised in the KV cache by message text + model — repeats like «спасибо» or
«подробнее» cost nothing the second time.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, TypeVar

from pydantic import BaseModel

from lectorium_chat.application.cache_helpers import TTL_7D, cached_llm_json
from lectorium_chat.domain.entities import Message
from lectorium_chat.domain.reply_language import ReplyLanguage
from lectorium_chat.observability.langfuse_client import prompt_with_fallback
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.observability.timing import stage


log = get_logger(__name__)
T = TypeVar("T", bound=BaseModel)

_FALLBACK_PATH = (
    Path(__file__).resolve().parent.parent
    / "agent" / "prompts" / "reply_language.md"
)

# Where the client persists what a previous turn settled on. Same ride as
# `aliases`: server → `done` event → client stores it on the assistant
# message → client replays it in `messages`.
MESSAGE_FIELD = "reply_language"


class _LLMForLanguage(Protocol):
    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T: ...


def _load_fallback() -> str:
    return _FALLBACK_PATH.read_text(encoding="utf-8")


def remembered_reply_language(
    history: list[dict[str, Any]] | None,
) -> ReplyLanguage | None:
    """The most recent language a previous turn settled on, or None.

    Read from the newest assistant message backwards, so a language changed
    mid-dialogue wins over the one before it. Anything malformed (a legacy
    client, a hand-rolled request) is treated as absent rather than fatal.
    """
    for entry in reversed(history or []):
        if entry.get("role") != "assistant":
            continue
        raw = entry.get(MESSAGE_FIELD)
        if raw is None:
            continue
        try:
            remembered = ReplyLanguage.model_validate(raw)
        except Exception:  # noqa: BLE001 — untrusted client payload
            continue
        if remembered.settled():
            return remembered
    return None


async def detect_reply_language(
    user_query: str,
    *,
    llm: _LLMForLanguage,
    request_id: str | None = None,
    model: str | None = None,
    kv_cache: Any | None = None,
    callbacks: list[Any] | None = None,
) -> ReplyLanguage | None:
    """The language this message calls for, or None when it says nothing.

    None is a normal outcome, not a failure: on «БГ 2.13» there is nothing to
    read, and guessing would be worse than keeping the settled language. Any
    error is also None — the language hint must never break the turn.
    """
    query = (user_query or "").strip()
    if not query:
        return None

    prompt = prompt_with_fallback("reply-language", fallback=_load_fallback)
    effective_model = prompt.config.get("model") or model
    messages: list[Message] = [
        {"role": "system", "content": prompt.text},
        {"role": "user", "content": query},
    ]

    async def _call() -> ReplyLanguage:
        async with stage("reply_language", request_id=request_id):
            return await llm.structured_output(
                messages,
                ReplyLanguage,
                model=effective_model,
                callbacks=callbacks,
                run_name="reply_language",
            )

    try:
        if kv_cache is not None:
            detected = await cached_llm_json(
                kv_cache,
                ns="reply_lang",
                key_parts={"q": query, "model": effective_model or ""},
                ttl_s=TTL_7D,
                schema=ReplyLanguage,
                factory=_call,
            )
        else:
            detected = await _call()
    except Exception as exc:  # noqa: BLE001 — never fail the turn on the hint
        log.warning("reply_language_failed", request_id=request_id, error=str(exc))
        return None

    if not detected.settled():
        return None
    log.info(
        "reply_language_detected",
        request_id=request_id,
        lang=detected.lang,
        requested=detected.requested,
    )
    return detected
