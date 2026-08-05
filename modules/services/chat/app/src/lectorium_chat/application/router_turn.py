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

from lectorium_chat.application.cache_helpers import TTL_7D, cached_llm_json
from lectorium_chat.domain.entities import Message
from lectorium_chat.domain.routing import RoutingDecision
from lectorium_chat.observability.langfuse_client import prompt_with_fallback
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.observability.timing import stage


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


# The soft fallback for a shaky classification is `unknown`, which
# `route_after_router` sends through a light research pass — never a tool-less
# refusal. That makes the collapse a no-op for `research` and a downgrade for
# everything else, so only ONE intent still takes it.
#
# What the collapse used to cost, for intents whose worker is not a search:
#   help          — answered from the lecture corpus instead of the bundled
#                   docs, AND lost its quota refund (api/chat.py reads the
#                   intent AFTER this rewrite, so an exempt turn stopped
#                   being exempt);
#   create_action — `route_after_research` compares against "create_action",
#                   so the research→action chain broke and no PDF card was
#                   ever produced;
#   add-to-library— the corpus-only path the prompt explicitly forbids for it
#                   («I have no internet access» to a web-search request);
#   recommend     — a semantic search for the literal words «что мне
#                   послушать дальше»;
#   show_verse    — the verse card, dropped.
# None of these is improved by pretending we did not classify it. A shaky
# intent still routes to the worker that can actually serve it, and that
# worker's own emptiness handling is the honest floor.
#
# `direct_chat` stays collapsible: it is the one intent whose worker does
# NOTHING, so a wrong guess there answers a real question with small talk —
# the light research pass is strictly better.
_COLLAPSIBLE_INTENTS = frozenset({"direct_chat"})


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
    prior_turn_had_refs: bool = False,
    has_current_track: bool = False,
    has_recent_history: bool = False,
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

    `prior_turn_had_refs` is a minimal conversation-context signal: True
    when the most recent assistant turn surfaced track refs the user can
    point at (from `extract_prior_track_refs`). Short follow-ups ("эту",
    "перескажи", "а PDF?") are ambiguous on the latest message ALONE — the
    same words route differently depending on whether the prior turn
    offered something to act on. The flag is surfaced to the classifier
    AND folded into the cache key so two same-text follow-ups in different
    contexts don't collide.

    `kv_cache` (optional) memoises the structured-output call by
    `(query, lang, model, prior_refs)`. The router runs at temperature=0
    so the output is deterministic for a given input + model — a perfect
    cache fit. On miss we still pay the LLM, but the second time the same
    question rolls in (in the same context) we skip the ~1s call entirely.
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
    # Surface the conversation + player context bits the classifier needs to
    # set deictic flags CONSISTENTLY with reality — so it doesn't flag
    # `current_ref` when no lecture is open, or `recent_ref`/`history_ref` when
    # there is no listen-history to resolve against. Kept terse +
    # machine-parseable so it can't be mistaken for part of the question.
    hint_parts: list[str] = []
    if prior_turn_had_refs:
        hint_parts.append(
            "the previous answer offered specific lectures/refs the user may "
            "be referring to"
        )
    hint_parts.append(
        "a lecture is currently open" if has_current_track
        else "no lecture is currently open"
    )
    hint_parts.append(
        "the user has listening history" if has_recent_history
        else "the user has NO listening history yet"
    )
    # Attach the hint to the SYSTEM message, not the user message: the user
    # controls their query text and could otherwise forge a `[context: …]`
    # block to flip the deictic flags. On the trusted system side it can't be
    # spoofed. (The state-side guards in conditional.py cross-check the flags
    # regardless, but keeping the signal un-forgeable is the cleaner contract.)
    context_hint = "\n\n[turn-context: " + "; ".join(hint_parts) + "]"
    messages: list[Message] = [
        {"role": "system", "content": f"{system_text}{context_hint}"},
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
            key_parts={
                "q": user_query,
                "lang": lang,
                "model": effective_model or "",
                # A short follow-up classified WITH prior refs available
                # must not serve a decision cached for the same text in a
                # no-context conversation, and vice-versa.
                "prior_refs": prior_turn_had_refs,
                # The player-context bits change the deictic-flag guidance, so
                # the same text under different context must not collide.
                "cur": has_current_track,
                "hist": has_recent_history,
            },
            ttl_s=TTL_7D,
            schema=RoutingDecision,
            factory=_call,
        )
    else:
        decision = await _call()
    # An unsure classification falls back to `unknown` — but only where that
    # buys something. See `_COLLAPSIBLE_INTENTS`: everywhere else it replaced a
    # worker that could serve the request with one that could not.
    if decision.confidence < 0.5 and decision.intent in _COLLAPSIBLE_INTENTS:
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
