"""Application use-case: classify a user query into one of the
`Intent` values and extract structured seed args for downstream nodes.

Pure: takes a `LLMPort` (dependency-injected by composition root)
and the query string. No graph knowledge, no LangChain imports
beyond what `LLMPort` carries.

Tested with `FakeLLM` that returns scripted `RoutingDecision`.
"""

from __future__ import annotations

from typing import Any, Protocol, TypeVar

from pydantic import BaseModel

from shruti_chat.application.cache_helpers import TTL_7D, cached_llm_json
from shruti_chat.domain.entities import Message
from shruti_chat.domain.routing import RoutingDecision
from shruti_chat.observability.langfuse_client import prompt_with_fallback
from shruti_chat.observability.logging import get_logger
from shruti_chat.observability.timing import stage


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
    ) -> T: ...


# Router intent classifier. Each line maps a class of phrasings to its
# intent so the model has a concrete anchor. We don't enumerate ALL
# phrasings — the model generalises — we just plant the boundary cases.
_ROUTER_SYSTEM_PROMPT = """\
You classify user queries for a Vedic library chat. The corpus has
five chunk kinds: transcript (lectures), verse (shlokas), commentary,
prose_chapter (book chapters), letter (Prabhupada's letters). A single
research session can iterate across all kinds — you do NOT need to
predict the chain.

Examples below are listed as ru / en pairs to keep parity between the
two main user languages. The `[lang=…]` tag in the user message tells
you which side carries more weight for that turn — but both sides
classify into the SAME intent. Topic-language never overrides intent.

Intents:
- direct_chat: greetings, thanks, meta-talk, no search needed.
  Examples (ru): "привет", "спасибо", "пока".
  Examples (en): "hi there", "thanks", "bye".
- help: ONLY in-app feature / how-the-app-works questions. The help
  worker reads bundled app docs. Use ONLY when the user is asking
  about the APP itself, NOT about lecture content or their own
  listening history.
  Examples (ru): "что ты умеешь?", "как создать плейлист?",
                 "где кнопка экспорта", "что значит зелёная точка".
  Examples (en): "what can you do", "how do I create a playlist",
                 "where is the export button",
                 "what does the green dot mean".
  DO NOT use `help` for personal-history asks like "что мне
  послушать" / "что я слушал" / "recommend me a lecture" /
  "what should I listen to next" — those route to `find_track`.
- research: ANY content search (lectures, verses, letters,
  commentaries) — including semantic search of the user's listening
  history when they remember a TOPIC ("про X") but not a date,
  AND any "find more like this fragment / lecture" request when
  there's a focused track/fragment in context (chunks_find_similar
  is a research tool).
  Examples (ru): "найди про карму", "БГ 2.13",
                 "комментарий к ШБ 5.5.3",
                 "что я недавно слушал про карму",
                 "найди что-то похожее на эту лекцию".
  Examples (en): "what did he say about devotion", "BG 2.13",
                 "letter about temple management",
                 "I heard about karma recently — find it",
                 "find me a similar fragment".
- find_track: catalog lookup by metadata — title, source/verse
  address, date, location, author, OR the user's listening history
  by TIME WINDOW (this week, yesterday) OR personal next-track
  recommendations (NOT "similar to" — that's research). **Playlist
  requests ("собери плейлист", "make a playlist") also belong here**
  — the result is a list of tracks; the client renders them as
  card-stack and offers a save-as-playlist action separately.
  Crucially: ANY "show / list / покажи / give me LECTURES" phrasing
  is find_track even when paired with a verse address, because the
  user wants a LIST OF TRACKS (rendered as `[^N]` cards), not
  a semantic snippet inside one. The catalog worker has
  `tracks_list(referenced_source_id=…)` for that case.
  Examples (ru): "утренние прогулки 1976 Бомбей",
                 "покажи лекции по БГ 2.13",
                 "лекции по второй главе Гиты",
                 "что я слушал на этой неделе",
                 "что мне послушать дальше",
                 "собери плейлист про карму".
  Examples (en): "morning walks 1976 Bombay",
                 "show lectures on SB 5.5.3",
                 "give me lectures about chapter 2",
                 "what I listened to this week",
                 "what should I listen to next",
                 "build a playlist on bhakti".
- create_action: user wants to TRIGGER or CREATE something — PDF
  export, daily reminder, smart-library setup, Pro upgrade.
  HARD RULE: if the query contains ANY of these tokens (case-
  insensitive, in either language), this is create_action REGARDLESS
  of surrounding topic words:
    pdf, pdf-ку, скачать, скачай, download, экспорт, export,
    поделиться, поделись, share, отправь, send me, распечатать,
    print, напоминай, напоминание, reminder, умная библиотека,
    smart library, авто-загрузка, auto-download, pro, подписка,
    subscribe, upgrade
  When a query mixes a topic ("про карму") with an action token
  ("pdf"), STILL pick create_action — the action_worker will use
  the topic to gather tracks itself. Do NOT route such queries to
  `research` just because they mention a topic.
  Examples (ru) — PDF:
    "сгенерируй pdf лекции",
    "скачать лекцию в PDF",
    "поделиться лекцией",
    "отправь мне pdf",
    "сохрани этот фрагмент в PDF",
    "сгенерируй pdf лекции про карму".
  Examples (en) — PDF:
    "generate a pdf of this lecture",
    "download the lecture as pdf",
    "share the lecture",
    "send me the pdf",
    "save this fragment as PDF",
    "make a pdf about karma".
  Examples (ru) — reminder / smart_library / pro:
    "напоминай мне каждое утро",
    "настрой ежедневное напоминание",
    "включи умную библиотеку",
    "настрой авто-загрузку лекций",
    "купить pro",
    "оформить подписку".
  Examples (en) — reminder / smart_library / pro:
    "remind me every morning",
    "set up a daily reminder",
    "turn on smart library",
    "configure auto-download",
    "upgrade to pro",
    "buy the subscription".
- unknown: ambiguous, out-of-scope, or doesn't fit any of the above.

Extract structured args ONLY for fields you can identify from the query:
- year (int), location (str), author (str)
- source_id (BG | SB | CC | KB | NoI | ISO | BS | MM | NBS)
- tokens (verse address like "2.13" or chapter token)
- doc_date_from / doc_date_to (ISO date — for letters)
- content_types (list of "transcript" | "verse" | "commentary" |
  "prose_chapter" | "letter") — hint for which corpora to search first
- kind (e.g. "morning_walk", "lecture", "conversation") — for transcripts
- action_kind (one of "pdf" | "reminder" | "smart_library" | "pro") —
  REQUIRED when intent=create_action. Pick by the trigger token:
  pdf/скачать/поделиться/download/share/export/print → "pdf";
  напоминай/reminder → "reminder";
  умная библиотека/smart library/auto-download → "smart_library";
  pro/подписка/subscribe/upgrade → "pro".

confidence: 0.0-1.0, your self-rated certainty in the intent. Below
0.5 means we route to "unknown" (soft fallback).

Respond ONLY with JSON matching the schema."""


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
    # Pull the router prompt from Langfuse per-turn so a prompt edit in
    # the UI propagates within `cache_ttl_seconds=60`. The hardcoded
    # `_ROUTER_SYSTEM_PROMPT` above stays in the repo as the fallback
    # path (Langfuse down / `LANGFUSE_FORCE_FALLBACK=1` / eval mode)
    # AND as the source of truth for the bootstrap script. The
    # `RoutingDecision` Pydantic schema lives in code, not in Langfuse
    # — config flow only carries strings, not types.
    router_prompt = prompt_with_fallback(
        "chat-router", fallback=_ROUTER_SYSTEM_PROMPT,
    )
    effective_model = router_prompt.config.get("model") or model
    messages: list[Message] = [
        {"role": "system", "content": router_prompt.text},
        {"role": "user", "content": f"[lang={lang}] {user_query}"},
    ]

    async def _call() -> RoutingDecision:
        async with stage("router", request_id=request_id):
            return await llm.structured_output(
                messages, RoutingDecision, model=effective_model, callbacks=callbacks,
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
