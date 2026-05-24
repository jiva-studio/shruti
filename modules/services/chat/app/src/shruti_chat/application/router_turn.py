"""Application use-case: classify a user query into one of the
`Intent` values and extract structured seed args for downstream nodes.

Pure: takes a `LLMPort` (dependency-injected by composition root)
and the query string. No graph knowledge, no LangChain imports
beyond what `LLMPort` carries.

Tested with `FakeLLM` that returns scripted `RoutingDecision`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, TypeVar

from pydantic import BaseModel

from shruti_chat.application.cache_helpers import TTL_7D, cached_llm_json
from shruti_chat.domain.entities import Message
from shruti_chat.domain.routing import RoutingDecision
from shruti_chat.observability.langfuse_client import prompt_with_fallback
from shruti_chat.observability.logging import get_logger
from shruti_chat.observability.timing import stage


_ROUTER_FALLBACK_PATH = (
    Path(__file__).resolve().parent.parent
    / "agent" / "prompts" / "router.md"
)


def _load_router_fallback() -> str:
    """Local-disk fallback for the router prompt — read on demand.

    Wrapped in a lazy callable so the import-time cost stays zero on
    paths where Langfuse is healthy and we never hit the fallback.
    """
    return _ROUTER_FALLBACK_PATH.read_text(encoding="utf-8")


log = get_logger(__name__)
T = TypeVar("T", bound=BaseModel)


class _LLMForRouting(Protocol):
    """Minimal subset of LLMPort that router needs. Narrowed to make
    test mocks small."""

    async def structured_output(
        self,
        messages: list[Message],
        schema: type[T],
        *,
        model: str | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> T: ...


# Router intent classifier lives in `agent/prompts/router.md`. It's
# loaded via `prompt_with_fallback("chat-router", fallback=…)` per
# turn so a Langfuse UI edit propagates within `cache_ttl_seconds=60`.
# The local `.md` file is the fallback path (Langfuse down /
# `LANGFUSE_FORCE_FALLBACK=1` / eval mode) AND the source pushed by
# `scripts/bootstrap_langfuse_prompts.py`.


async def run_router_turn(
    user_query: str,
    *,
    lang: str,
    llm: _LLMForRouting,
    request_id: str | None = None,
    model: str | None = None,
    kv_cache: "Any | None" = None,
    # Langfuse handler list. When the router result is served from the
    # KV cache (deterministic hit), no LLM call happens and the
    # callback is silently unused — that's correct: a cache hit isn't
    # a model interaction worth tracing.
    callbacks: list[Any] | None = None,
) -> RoutingDecision:
    """Classify the query, return a validated `RoutingDecision`.

    `lang` is included in the user message so the model can prefer
    same-language matching for `find_track` and `research` cues —
    e.g. "пиши" vs "find" hints at which dictionary to start from.
    `model` overrides the LLMPort's default; production uses Gemini
    Flash Lite for routing (cheap, deterministic with temperature=0
    inside structured_output).

    `kv_cache` (optional) memoises the structured-output call by
    `(query, lang, model)`. The router runs at temperature=0 so the
    output is deterministic for a given input + model — a perfect
    cache fit. On miss we still pay the LLM, but the second time the
    same question rolls in (router only sees the latest user turn)
    we skip the ~1s call entirely.
    """
    # Pull the router prompt from Langfuse per-turn so a UI edit
    # propagates within `cache_ttl_seconds=60`. Fallback path reads
    # the bundled `router.md`. `{{LANG}}` is substituted at the call
    # site (the prompt section carries it once instead of every user
    # message getting a `[lang=…]` prefix).
    router_prompt = prompt_with_fallback(
        "chat-router", fallback=_load_router_fallback,
    )
    system_text = router_prompt.text.replace("{{LANG}}", lang)
    effective_model = router_prompt.config.get("model") or model
    messages: list[Message] = [
        {"role": "system", "content": system_text},
        {"role": "user", "content": user_query},
    ]

    async def _call() -> RoutingDecision:
        async with stage("router", request_id=request_id):
            return await llm.structured_output(
                messages, RoutingDecision,
                model=effective_model, callbacks=callbacks,
                run_name="router_decision",
            )

    if kv_cache is not None:
        decision = await cached_llm_json(
            kv_cache,
            ns="router",
            # Cache key includes the EFFECTIVE model (post-Langfuse
            # override) so an A/B model swap in the UI invalidates the
            # cache automatically. Without this, a model change in
            # Langfuse would still serve stale `RoutingDecision`s
            # baked under the previous model for up to TTL_7D.
            key_parts={"q": user_query, "lang": lang, "model": effective_model or ""},
            ttl_s=TTL_7D,
            schema=RoutingDecision,
            factory=_call,
        )
    else:
        decision = await _call()
    # Low confidence collapses to "unknown" so downstream routing picks
    # the soft fallback path (synthesizer answers without tools).
    if decision.confidence < 0.5 and decision.intent != "unknown":
        log.info(
            "router_low_confidence_to_unknown",
            request_id=request_id,
            original_intent=decision.intent,
            confidence=round(decision.confidence, 3),
        )
        decision = RoutingDecision(
            intent="unknown",
            confidence=decision.confidence,
            extracted_args=decision.extracted_args,
        )
    log.info(
        "router_decision",
        request_id=request_id,
        intent=decision.intent,
        confidence=round(decision.confidence, 3),
        extracted_args_keys=list(decision.extracted_args.keys()),
        query_chars=len(user_query),
    )
    return decision
