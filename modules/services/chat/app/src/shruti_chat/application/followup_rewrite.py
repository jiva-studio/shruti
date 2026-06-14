"""Resolve a context-dependent follow-up into a self-contained query BEFORE
classification.

The classifier (deterministic chain + LLM router) and retrieval work on the
current message ALONE — they don't read history. So a short follow-up like
«А ещё?» (after an answer about asuras) routes to `direct_chat` and the
synthesizer free-forms an ungrounded reply. This pre-step rewrites such a
message into «Ещё стихи БГ о природе асуров» using the conversation, so the
rest of the pipeline classifies + retrieves a real, standalone query.

Gated: skipped on the first turn (no history) and on messages that are already
long enough to be self-contained, so normal queries pay no extra LLM call.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, TypeVar

from pydantic import BaseModel

from shruti_chat.domain.entities import Message
from shruti_chat.observability.langfuse_client import prompt_with_fallback
from shruti_chat.observability.logging import get_logger
from shruti_chat.observability.timing import stage

log = get_logger(__name__)
T = TypeVar("T", bound=BaseModel)

_FALLBACK_PATH = Path(__file__).resolve().parent.parent / "agent" / "prompts" / "followup_rewrite.md"

# Above this many words a message is almost always self-contained, so we skip
# the rewrite call. Follow-ups that need context («А ещё?», «подробнее»,
# «а где это в писании?») are short.
_MAX_SELF_CONTAINED_WORDS = 8
# Only the last few turns matter for resolving a deictic reference.
_HISTORY_WINDOW = 4


class _LLMForRewrite(Protocol):
    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T: ...


class FollowupRewrite(BaseModel):
    query: str


def _load_fallback() -> str:
    return _FALLBACK_PATH.read_text(encoding="utf-8")


def _needs_rewrite(history: list[dict[str, Any]] | None, user_query: str) -> bool:
    if not history:
        return False
    return len(user_query.split()) <= _MAX_SELF_CONTAINED_WORDS


async def resolve_followup_query(
    history: list[dict[str, Any]] | None,
    user_query: str,
    *,
    llm: _LLMForRewrite,
    request_id: str | None = None,
    model: str | None = None,
    callbacks: list[Any] | None = None,
) -> str:
    """Return a self-contained version of `user_query`, or `user_query`
    unchanged when no history / already self-contained / on any failure."""
    if not _needs_rewrite(history, user_query):
        return user_query

    recent = (history or [])[-_HISTORY_WINDOW:]
    convo = "\n".join(
        f"{m.get('role', '?')}: {str(m.get('content', '')).strip()[:500]}"
        for m in recent
        if m.get("content")
    )
    if not convo:
        return user_query

    prompt = prompt_with_fallback("chat-followup-rewrite", fallback=_load_fallback)
    messages: list[Message] = [
        {"role": "system", "content": prompt.text},
        {
            "role": "user",
            "content": (
                f"Conversation so far:\n{convo}\n\n"
                f"Latest user message: {user_query}\n\n"
                "Return the self-contained query (verbatim if already self-contained)."
            ),
        },
    ]
    try:
        async with stage("followup_rewrite", request_id=request_id):
            out = await llm.structured_output(
                messages,
                FollowupRewrite,
                model=prompt.config.get("model") or model,
                callbacks=callbacks,
                run_name="followup_rewrite",
            )
    except Exception as exc:  # noqa: BLE001 — never fail the turn on the rewrite
        log.warning("followup_rewrite_failed", request_id=request_id, error=str(exc))
        return user_query

    rewritten = (out.query or "").strip()
    if not rewritten:
        return user_query
    if rewritten != user_query:
        log.info(
            "followup_rewritten",
            request_id=request_id,
            original=user_query[:80],
            rewritten=rewritten[:120],
        )
    return rewritten
