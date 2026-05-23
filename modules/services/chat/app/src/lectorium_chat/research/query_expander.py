"""query_expander — single LLM call producing diversified search queries.

Does NOT classify intent and does NOT re-extract entities — both already
happened in `router_turn`. This module exists so the long path's fanout has
3-5 different angles into the embedding space instead of one query.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from lectorium_chat.domain.entities import Message
from lectorium_chat.observability.langfuse_client import prompt_with_fallback
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.models import ExpansionResult


log = get_logger(__name__)

_PROMPT_PATH = (
    Path(__file__).parent.parent / "agent" / "prompts" / "query_expander.md"
)


def _load_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def _format_user(question: str, lang: str, router_args: dict[str, Any]) -> str:
    return (
        f"Input:\n"
        f"  question: {json.dumps(question, ensure_ascii=False)}\n"
        f"  lang: {json.dumps(lang)}\n"
        f"  router_args: {json.dumps(router_args, ensure_ascii=False)}"
    )


async def expand_query(
    question: str,
    lang: str,
    router_args: dict[str, Any],
    *,
    llm: Any,
    model: str | None = None,
    callbacks: list[Any] | None = None,
) -> ExpansionResult:
    """Run one structured-output LLM call. On any error returns a degraded
    result with just [question] so the caller's fanout still has something
    to search."""
    try:
        # Pull the system prompt from Langfuse for hot-reload; fall back
        # to the bundled .md so a Langfuse outage doesn't drop traffic.
        # The handle.config["model"] override (if set in Langfuse UI)
        # wins over the `model` argument — this is what lets us A/B a
        # cheaper model from the Langfuse playground without a deploy.
        prompt = prompt_with_fallback("query-expander", fallback=_load_prompt)
        effective_model = prompt.config.get("model") or model
        messages: list[Message] = [
            {"role": "system", "content": prompt.text},
            {"role": "user", "content": _format_user(question, lang, router_args or {})},
        ]
        result: ExpansionResult = await llm.structured_output(
            messages, ExpansionResult,
            model=effective_model, callbacks=callbacks,
            run_name="query_expander",
        )
        # Defensive — drop empty / overly long queries.
        cleaned = [q.strip() for q in result.queries if q and q.strip()]
        if not cleaned:
            log.warning("query_expander_empty_output", question_chars=len(question))
            return ExpansionResult(queries=[question])
        return ExpansionResult(queries=cleaned[:5])
    except (ValidationError, Exception) as exc:  # noqa: BLE001 — best-effort
        log.warning("query_expander_failed", error=str(exc), question_chars=len(question))
        return ExpansionResult(queries=[question])
