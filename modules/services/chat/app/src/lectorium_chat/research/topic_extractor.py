"""topic_extractor — single LLM call producing 2-5 topic labels for
matching against topic-attributions in the LONG path."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from lectorium_chat.application.cache_helpers import TTL_7D, cached_json
from lectorium_chat.domain.entities import Message
from lectorium_chat.observability.langfuse_client import prompt_with_fallback
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.constants import TOPIC_MAX_TOPICS_EXTRACTED
from lectorium_chat.research.models import TopicExtractionResult


log = get_logger(__name__)

_PROMPT_PATH = (
    Path(__file__).parent.parent / "agent" / "prompts" / "topic_extractor.md"
)


def _load_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def _format_user(question: str, lang: str, expansion_queries: list[str]) -> str:
    payload = {
        "question": question,
        "lang": lang,
        "expansion_queries_for_context": expansion_queries,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


async def extract_topics(
    question: str,
    lang: str,
    expansion_queries: list[str],
    *,
    llm: Any,
    model: str | None = None,
    kv_cache: Any | None = None,
    callbacks: list[Any] | None = None,
) -> list[str]:
    """Run one structured-output LLM call. On any error or empty output
    returns [] — the caller falls through to fanout without topic-boost.

    Cached by `(question, lang, expansion, model)`. Topics on the same
    question are deterministic enough to reuse; the cache TTL is 7 days
    so a prompt iteration on `topic_extractor.md` invalidates naturally
    via the bytes-of-prompt baked into the cached payload (we re-read
    the prompt every call, so even a deploy that only ships a new
    prompt regenerates topics on first call after restart due to the
    L1 reset; L2 will hit but with stale topics until TTL — acceptable
    since topics inform boosting, not grounding).
    """

    async def _call() -> list[str]:
        try:
            prompt = prompt_with_fallback("topic-extractor", fallback=_load_prompt)
            effective_model = prompt.config.get("model") or model
            messages: list[Message] = [
                {"role": "system", "content": prompt.text},
                {"role": "user", "content": _format_user(question, lang, expansion_queries or [])},
            ]
            result: TopicExtractionResult = await llm.structured_output(
                messages, TopicExtractionResult,
                model=effective_model, callbacks=callbacks,
                run_name="topic_extractor",
            )
            cleaned = [t.strip() for t in result.topics if t and t.strip()]
            return cleaned[:TOPIC_MAX_TOPICS_EXTRACTED]
        except (ValidationError, Exception) as exc:  # noqa: BLE001 — best-effort
            log.warning("topic_extractor_failed", error=str(exc), question_chars=len(question))
            return []

    if kv_cache is None:
        return await _call()
    return await cached_json(
        kv_cache,
        ns="topic",
        key_parts={
            "q": question,
            "lang": lang,
            "exp": expansion_queries or [],
            "model": model or "",
        },
        ttl_s=TTL_7D,
        factory=_call,
    )
