"""get_track_outline — lazy outline generation + cache.

Flow per (track_id, lang):
1. Catalog → resolve transcript path + effective lang (lang fallback).
2. OutlineCache → HEAD; if hit, GET and return.
3. TranscriptStorage → fetch transcript; LLM → generate outline.
4. OutlineCache → PUT (conditional); on race, refetch.

Outline is an INTERNAL artifact — the mobile app does not read it from
CDN. The chat-agent reads and writes it; payload is delivered to the
client inline via the SSE `outline` event plus an `[outline:track_id]`
marker emitted by the LLM.
"""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable

from shruti_chat.agent import llm
from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.config import get_settings
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.domain.ports.outline_cache import OutlineCache, OutlineCacheConflict
from shruti_chat.domain.ports.transcript_storage import TranscriptStorage
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


YieldEvent = Callable[[str, dict[str, Any]], None]


def _noop_yield(_type: str, _data: dict[str, Any]) -> None:
    """Fallback when this tool is invoked outside the agent loop (tests)."""


# Per-(track_id, lang) async locks. Two concurrent /chat requests in the
# same worker process that both ask for an outline of the same track will
# serialize through this lock — the second one re-HEADs cache inside the
# critical section and reads the freshly-written artifact rather than
# paying for a redundant gemini-flash call.
#
# Cross-process races (two workers, two pods) are caught by the
# conditional PUT below (`if_none_match=True`).
_OUTLINE_LOCKS: defaultdict[tuple[str, str], asyncio.Lock] = defaultdict(
    asyncio.Lock
)


_OUTLINE_PROMPT_RU = """Ты помощник, который составляет краткое оглавление лекции по таймкодированному транскрипту.

Правила:
1. Верни JSON-массив из 5-8 объектов: {"start": "MM:SS" или "HH:MM:SS", "title": "..."}.
2. title — 3-6 слов на русском, в регистре предложения, описывает ТЕМУ фрагмента, не цитата.
3. start — реальный таймкод из транскрипта (копируй из меток [MM:SS] / [HH:MM:SS] в начале строк, не выдумывай).
4. Темы должны логически делить лекцию на содержательные части по ходу повествования.
5. Не дублируй смысл между пунктами.
6. ЗАПРЕЩЕНО: кавычки, эмодзи, восклицательные/вопросительные знаки в заголовках, кликбейт ("Шокирующая правда о...", "Ты не поверишь..."), префиксы вроде "Прабхупада объясняет" — пиши тему как есть.

Верни ТОЛЬКО валидный JSON-массив, без обёртки, без markdown, без комментариев."""


_OUTLINE_PROMPT_EN = """You generate a chapter outline for one lecture from its time-coded transcript.

Rules:
1. Return a JSON array of 5-8 objects: {"start": "MM:SS" or "HH:MM:SS", "title": "..."}.
2. title is 3-6 words in English, sentence case, describing the TOPIC discussed in that segment. Not a quotation.
3. start is a real timecode from the transcript (copy from the [MM:SS] / [HH:MM:SS] markers at the start of lines — don't invent).
4. Topics must split the lecture into coherent narrative parts in order.
5. Don't restate the same topic across items.
6. FORBIDDEN: quote marks, emoji, exclamation/question marks in titles, clickbait phrasing ("Shocking truth about..."), "Prabhupada explains" / "The lecture about" prefixes — write the topic itself.

Return ONLY a valid JSON array. No wrapper object, no markdown, no commentary."""


def _outline_system_prompt(lang: str) -> str:
    return _OUTLINE_PROMPT_EN if lang == "en" else _OUTLINE_PROMPT_RU


def _fmt_ts(ms: int) -> str:
    s = ms // 1000
    h = s // 3600
    m = (s % 3600) // 60
    sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


def _parse_ts(ts: str) -> int:
    parts = [int(p) for p in ts.split(":")]
    if len(parts) == 2:
        h, (m, s) = 0, parts
    elif len(parts) == 3:
        h, m, s = parts
    else:
        return 0
    return (h * 3600 + m * 60 + s) * 1000


def _build_user_prompt(transcript: dict) -> str:
    lines: list[str] = []
    for b in transcript.get("blocks") or []:
        if b.get("type") == "paragraph":
            continue
        text = b.get("text")
        if isinstance(text, list):
            text = " ".join(text)
        if not isinstance(text, str) or not text.strip():
            continue
        lines.append(f"[{_fmt_ts(b['start'])}] {text.strip()}")
    return "Транскрипт лекции:\n\n" + "\n".join(lines)


def _strip_json_fence(s: str) -> str:
    """Models sometimes wrap output in ```json ... ``` despite instructions."""
    t = s.strip()
    if t.startswith("```"):
        t = t.lstrip("`")
        if t.lower().startswith("json"):
            t = t[4:]
        t = t.lstrip("\n")
        if t.endswith("```"):
            t = t[:-3]
    return t.strip()


def _items_from_llm_json(raw: str) -> list[dict[str, Any]]:
    parsed = json.loads(_strip_json_fence(raw))
    if not isinstance(parsed, list):
        raise ValueError("outline llm response is not a list")
    out: list[dict[str, Any]] = []
    for it in parsed:
        if not isinstance(it, dict):
            continue
        start_raw = it.get("start") or it.get("start_ms")
        title = (it.get("title") or "").strip()
        if not title:
            continue
        if isinstance(start_raw, int):
            start_ms = start_raw
        elif isinstance(start_raw, str):
            start_ms = _parse_ts(start_raw)
        else:
            continue
        out.append({"start_ms": start_ms, "title": title})
    return out


async def _generate_outline(
    track_id: str,
    transcript_path: str,
    effective_lang: str,
    transcript_storage: TranscriptStorage,
) -> dict[str, Any]:
    """Run the LLM on a resolved transcript. Caller passes the
    transcript path + the language of THAT transcript (which may differ
    from the originally requested lang — see
    CatalogRepository.resolve_transcript_path) so the outline prompt is
    paired with the right language."""
    s = get_settings()
    transcript = await transcript_storage.fetch(transcript_path)
    user_prompt = _build_user_prompt(transcript)

    resp = await llm.acompletion(
        model=s.llm_outline,
        messages=[
            {"role": "system", "content": _outline_system_prompt(effective_lang)},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
    )
    text = resp.choices[0].message.content or ""
    items = _items_from_llm_json(text)
    if not items:
        raise RuntimeError("outline_empty")
    return {
        "trackId": track_id,
        "language": effective_lang,
        "model": s.llm_outline,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "items": items,
    }


async def _cache_get_silent(
    cache: OutlineCache, track_id: str, lang: str, where: str,
) -> dict[str, Any] | None:
    try:
        return await cache.get(track_id, lang)
    except Exception as exc:
        log.warning(where, track_id=track_id, lang=lang, error=str(exc))
        return None


async def _cache_head_silent(
    cache: OutlineCache, track_id: str, lang: str, where: str,
) -> bool:
    try:
        return await cache.head(track_id, lang)
    except Exception as exc:
        log.warning(where, track_id=track_id, lang=lang, error=str(exc))
        return False


async def ensure_outline_payload(
    track_id: str,
    transcript_path: str,
    effective_lang: str,
    *,
    transcript_storage: TranscriptStorage,
    outline_cache: OutlineCache,
) -> dict[str, Any] | None:
    """Resolve the outline payload for one track — cache or cold-path.

    Inputs are pre-resolved by the caller (so a caller that already
    looked up `transcript_path` / `effective_lang` doesn't pay for a
    second catalog lookup). On any failure the function returns `None`
    so the caller can render its artifact without an outline rather
    than fail loudly. Concurrent generation for the same key is
    serialised by `_OUTLINE_LOCKS`; cross-process races are caught by
    the conditional PUT.
    """
    payload: dict[str, Any] | None = None
    if await _cache_head_silent(
        outline_cache, track_id, effective_lang, "outline_head_failed",
    ):
        payload = await _cache_get_silent(
            outline_cache, track_id, effective_lang, "outline_get_failed",
        )
    if payload is not None:
        return payload

    async with _OUTLINE_LOCKS[(track_id, effective_lang)]:
        if await _cache_head_silent(
            outline_cache, track_id, effective_lang,
            "outline_head_failed_in_lock",
        ):
            payload = await _cache_get_silent(
                outline_cache, track_id, effective_lang,
                "outline_get_failed_in_lock",
            )
        if payload is not None:
            return payload

        try:
            payload = await _generate_outline(
                track_id, transcript_path, effective_lang, transcript_storage,
            )
        except Exception as exc:
            log.warning(
                "outline_generate_failed",
                track_id=track_id, lang=effective_lang, error=str(exc),
            )
            return None

        # Conditional PUT — refuses to overwrite if another worker
        # (different pod / process) wrote the artifact while we were
        # running gemini-flash. On loss, refetch theirs.
        try:
            await outline_cache.put(
                track_id, effective_lang, payload, if_none_match=True,
            )
        except OutlineCacheConflict:
            log.info(
                "outline_put_lost_race",
                track_id=track_id, lang=effective_lang,
            )
            refreshed = await _cache_get_silent(
                outline_cache, track_id, effective_lang,
                "outline_get_after_race_failed",
            )
            if refreshed is not None:
                payload = refreshed
        except Exception as exc:
            # Persist failure isn't fatal — return the freshly-generated
            # payload anyway, so the caller's hot artifact gets the
            # outline even if the next request has to regenerate.
            log.warning(
                "outline_put_failed",
                track_id=track_id, lang=effective_lang, error=str(exc),
            )
        return payload


async def get_track_outline(
    track_id: str,
    lang: str = "ru",
    *,
    yield_event: YieldEvent = _noop_yield,
    catalog_repo: CatalogRepository,
    transcript_storage: TranscriptStorage,
    outline_cache: OutlineCache,
) -> dict[str, Any]:
    """Return outline items + emit `outline` side-event for the client.

    `lang` is the user's preferred outline language; the actual transcript
    we read from may be in a different language if the requested one
    isn't available for this track (e.g. English-only lecture asked for
    in a Russian session). The cache key + emitted payload use the
    effective transcript language so subsequent requests in either
    language land on the same artifact.
    """
    transcript_path, effective_lang = await catalog_repo.resolve_transcript_path(
        track_id, requested_lang=lang,
    )
    if not transcript_path:
        return {
            "error": "transcript_unavailable",
            "track_id": track_id,
            "lang": lang,
        }

    payload = await ensure_outline_payload(
        track_id, transcript_path, effective_lang,
        transcript_storage=transcript_storage, outline_cache=outline_cache,
    )
    if payload is None:
        return {
            "error": "outline_empty",
            "track_id": track_id,
            "lang": effective_lang,
        }

    items = payload.get("items") or []
    yield_event(
        "action",
        {
            "kind": "outline",
            "id": f"outline_{track_id}",
            "payload": {"track_id": track_id, "items": items},
        },
    )
    return {
        "track_id": track_id,
        "lang": effective_lang,
        "items": items,
    }


register_tool(ToolDef(
    name="track_outline_get",
    fn=get_track_outline,
    emits_events=True,
    description=(
        "Generate (or fetch cached) outline for a track: 5-8 chapter-like "
        "items with timecodes (start_ms) and titles. Use when the user asks "
        "for a summary, the contents of a lecture, or 'recap what I just "
        "listened to'. After calling, embed the marker '[outline:<track_id>]' "
        "in your reply where the outline card should render — the client "
        "mounts an interactive list at that position."
    ),
    parameters={
        "type": "object",
        "properties": {
            "track_id": {"type": "string"},
            "lang": {"type": "string", "enum": ["ru", "en"]},
        },
        "required": ["track_id"],
    },
))
