"""query_planner — single LLM call producing 1-4 typed sub-questions.

Replaces `query_expander`. The expander produced paraphrase-variations of one
question; the planner produces typed decompositions. On simple questions it
returns 1 sub_query (equivalent to a single-query fallback); on multi-intent
questions it returns 2-4 sub_queries of different types, so the downstream
fanout retrieves distinct themes instead of paraphrases of one center.

Does NOT classify intent and does NOT re-extract entities — both already
happened in `router_turn`.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from lectorium_chat.domain.entities import Message
from lectorium_chat.observability.langfuse_client import prompt_with_fallback
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.models import QueryPlan, SubQuery


log = get_logger(__name__)

_PROMPT_PATH = (
    Path(__file__).parent.parent / "agent" / "prompts" / "query_planner.md"
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


def _degraded_plan(question: str) -> QueryPlan:
    """Single-sub_query plan with the raw question. Used on any LLM error
    so the downstream fanout still has something to search — equivalent to
    the old `query_expander` fallback behaviour."""
    return QueryPlan(
        sub_queries=[
            SubQuery(id=0, type="general", text=question, alt_phrasings=[]),
        ],
    )


async def plan_queries(
    question: str,
    lang: str,
    router_args: dict[str, Any],
    *,
    llm: Any,
    model: str | None = None,
    callbacks: list[Any] | None = None,
) -> QueryPlan:
    """Run one structured-output LLM call. On any error returns a degraded
    plan with a single sub_query containing the raw question."""
    try:
        prompt = prompt_with_fallback("query-planner", fallback=_load_prompt)
        effective_model = prompt.config.get("model") or model
        messages: list[Message] = [
            {"role": "system", "content": prompt.text},
            {"role": "user", "content": _format_user(question, lang, router_args or {})},
        ]
        result: QueryPlan = await llm.structured_output(
            messages, QueryPlan,
            model=effective_model, callbacks=callbacks,
            run_name="query_planner",
        )
        cleaned = _clean(result, question)
        if not cleaned.sub_queries:
            log.warning("query_planner_empty_output", question_chars=len(question))
            return _degraded_plan(question)
        return cleaned
    except (ValidationError, Exception) as exc:  # noqa: BLE001 — best-effort
        log.warning("query_planner_failed", error=str(exc), question_chars=len(question))
        return _degraded_plan(question)


def _clean(plan: QueryPlan, question: str) -> QueryPlan:
    """Drop empty texts, enforce id sequence, cap to 4 sub_queries, cap
    alt_phrasings at 2 per sub_query. The LLM's `id` field is ignored —
    we re-assign positionally to guarantee a clean 0..N sequence even when
    the model emits non-sequential ids."""
    cleaned: list[SubQuery] = []
    for sq in plan.sub_queries:
        text = (sq.text or "").strip()
        if not text:
            continue
        alts = [a.strip() for a in (sq.alt_phrasings or []) if a and a.strip()][:2]
        cleaned.append(
            SubQuery(
                id=len(cleaned),
                type=sq.type,
                text=text,
                alt_phrasings=alts,
            )
        )
        if len(cleaned) >= 4:
            break
    return QueryPlan(sub_queries=cleaned)
