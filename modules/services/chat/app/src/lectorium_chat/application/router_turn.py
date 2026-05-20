"""Application use-case: classify a user query into one of the
`Intent` values and extract structured seed args for downstream nodes.

Pure: takes a `LLMPort` (dependency-injected by composition root)
and the query string. No graph knowledge, no LangChain imports
beyond what `LLMPort` carries.

Tested with `FakeLLM` that returns scripted `RoutingDecision`.
"""

from __future__ import annotations

from typing import Protocol, TypeVar

from pydantic import BaseModel

from lectorium_chat.domain.entities import Message
from lectorium_chat.domain.routing import RoutingDecision
from lectorium_chat.observability.logging import get_logger


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

Intents:
- direct_chat: greetings, thanks, meta-talk, no search needed.
  Examples: "привет", "спасибо", "пока", "hi there".
- help: ONLY in-app feature / how-the-app-works questions. The help
  worker reads bundled app docs. Use ONLY when the user is asking
  about the APP itself, NOT about lecture content or their own
  listening history.
  Examples: "что ты умеешь?", "как создать плейлист?", "where is
  the export button", "what does the green dot mean", "how do I
  change region", "what can you do".
  DO NOT use `help` for "что мне послушать", "что я слушал",
  "recommend me a lecture", "what should I listen to next" — those
  are personal-history questions, route them to `find_track`.
- research: ANY content search (lectures, verses, letters,
  commentaries) — including semantic search of the user's listening
  history when they remember a TOPIC ("про X") but not a date,
  AND any "find more like this fragment / lecture" request when
  there's a focused track/fragment in context (chunks_find_similar
  is a research tool).
  Examples: "найди про карму", "БГ 2.13", "what did he say about
  devotion", "комментарий к ШБ 5.5.3", "letter about temple
  management", "что я недавно слушал про карму", "I heard about
  karma recently — find it", "найди что-то похожее на эту лекцию",
  "recommend more like this fragment", "find me a similar fragment".
- find_track: catalog lookup by metadata — title, source/verse
  address, date, location, author, OR the user's listening history
  by TIME WINDOW (this week, yesterday) OR personal next-track
  recommendations (NOT "similar to" — that's research).
  Crucially: ANY "show / list / покажи / give me LECTURES" phrasing
  is find_track even when paired with a verse address, because the
  user wants a LIST OF TRACKS (rendered as `[card:N]` cards), not
  a semantic snippet inside one. The catalog worker has
  `tracks_list(referenced_source_id=…)` for that case.
  Examples: "утренние прогулки 1976 Бомбей", "лекции Бхактиведанты",
  "покажи лекции по БГ 2.13", "show lectures on SB 5.5.3",
  "лекции по второй главе Гиты", "give me lectures about chapter 2",
  "что я слушал на этой неделе", "что я слушал вчера",
  "что мне послушать дальше", "what should I listen to next".
- create_action: user wants to create or trigger something (playlist,
  PDF, reminder).
  Examples: "сделай плейлист про преданное служение",
  "сохрани этот фрагмент в PDF".
- unknown: ambiguous, out-of-scope, or doesn't fit any of the above.

Extract structured args ONLY for fields you can identify from the query:
- year (int), location (str), author (str)
- source_id (BG | SB | CC | KB | NoI | ISO | BS | MM | NBS)
- tokens (verse address like "2.13" or chapter token)
- doc_date_from / doc_date_to (ISO date — for letters)
- content_types (list of "transcript" | "verse" | "commentary" |
  "prose_chapter" | "letter") — hint for which corpora to search first
- kind (e.g. "morning_walk", "lecture", "conversation") — for transcripts

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
) -> RoutingDecision:
    """Classify the query, return a validated `RoutingDecision`.

    `lang` is included in the user message so the model can prefer
    same-language matching for `find_track` and `research` cues —
    e.g. "пиши" vs "find" hints at which dictionary to start from.
    `model` overrides the LLMPort's default; production uses Gemini
    Flash Lite for routing (cheap, deterministic with temperature=0
    inside structured_output).
    """
    messages: list[Message] = [
        {"role": "system", "content": _ROUTER_SYSTEM_PROMPT},
        {"role": "user", "content": f"[lang={lang}] {user_query}"},
    ]
    decision = await llm.structured_output(messages, RoutingDecision, model=model)
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
