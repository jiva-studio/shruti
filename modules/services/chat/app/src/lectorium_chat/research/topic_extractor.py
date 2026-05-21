"""topic_extractor — single LLM call producing 2-5 topic labels for
matching against topic-attributions in the LONG path."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from lectorium_chat.domain.entities import Message
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
) -> list[str]:
    """Run one structured-output LLM call. On any error or empty output
    returns [] — the caller falls through to fanout without topic-boost."""
    try:
        messages: list[Message] = [
            {"role": "system", "content": _load_prompt()},
            {"role": "user", "content": _format_user(question, lang, expansion_queries or [])},
        ]
        result: TopicExtractionResult = await llm.structured_output(
            messages, TopicExtractionResult, model=model,
        )
        cleaned = [t.strip() for t in result.topics if t and t.strip()]
        return cleaned[:TOPIC_MAX_TOPICS_EXTRACTED]
    except (ValidationError, Exception) as exc:  # noqa: BLE001 — best-effort
        log.warning("topic_extractor_failed", error=str(exc), question_chars=len(question))
        return []
