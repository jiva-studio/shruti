"""get_track_outline — lazy outline generation + S3 cache.

Flow per (track_id, lang):
1. HEAD artifacts/tracks/{id}/outlines/{lang}.json  → if 200, GET and return.
2. Otherwise: fetch transcript from public/, generate via gemini-flash,
   PUT to S3, return.

Outline is an INTERNAL artifact — the mobile app does not read it from CDN.
The chat-agent reads (and writes) it; payload is delivered to the client
inline via SSE event `outline` plus a `[outline:track_id]` marker emitted
by the LLM.

Returns: list of `{start_ms, title}` items.
"""

from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable

from lectorium_chat.agent import llm
from lectorium_chat.config import get_settings
from lectorium_chat.indexer.s3 import (
    OutlineAlreadyExists,
    fetch_transcript,
    get_outline_sync,
    outline_exists_sync,
    put_outline_sync,
)
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.agent.tools._sqlite import catalog_conn

log = get_logger(__name__)


YieldEvent = Callable[[str, dict[str, Any]], None]


def _noop_yield(_type: str, _data: dict[str, Any]) -> None:
    """Fallback when this tool is invoked outside the agent loop (tests)."""


# Per-(track_id, lang) async locks. Two concurrent /chat requests in the
# same worker process that both ask for an outline of the same track will
# now serialize through this lock — the second one re-HEADs S3 inside the
# critical section and reads the freshly-written artifact rather than
# paying for a redundant gemini-flash call.
#
# Cross-process races (two workers, two pods) are caught by the
# conditional PUT below (If-None-Match: *).
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
        # leading 'json' or other lang tag, then \n
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


def _resolve_transcript_sync(
    track_id: str, requested_lang: str
) -> tuple[str | None, str]:
    """Pick the best available transcript for a track.

    Returns `(transcript_path, effective_lang)`. Tries the requested
    language first; if the track has no transcript in that language,
    falls back to ANY language that does have one (English lecture
    asked for in a Russian session, etc.) — better than 'unavailable'
    when an outline can still be produced from an alternate variant.

    `(None, requested_lang)` when the track has no transcripts at all.
    """
    with catalog_conn() as conn:
        # Preferred language first.
        row = conn.execute(
            "SELECT transcript_path FROM track_variants "
            "WHERE track_id = ? AND language = ? "
            "  AND transcript_path IS NOT NULL AND transcript_path <> ''",
            (track_id, requested_lang),
        ).fetchone()
        if row and row["transcript_path"]:
            return row["transcript_path"], requested_lang
        # Fall back to any transcript the catalog has.
        row = conn.execute(
            "SELECT language, transcript_path FROM track_variants "
            "WHERE track_id = ? "
            "  AND transcript_path IS NOT NULL AND transcript_path <> '' "
            "LIMIT 1",
            (track_id,),
        ).fetchone()
        if row and row["transcript_path"]:
            return row["transcript_path"], str(row["language"])
    return None, requested_lang


async def _generate_outline(
    track_id: str,
    transcript_path: str,
    effective_lang: str,
    settings_=None,
) -> dict[str, Any]:
    """Run the LLM on a resolved transcript. Caller passes the
    transcript path + the language of THAT transcript (which may differ
    from the originally requested lang — see `_resolve_transcript_sync`)
    so the outline prompt is paired with the right language."""
    s = settings_ or get_settings()
    transcript = await fetch_transcript(transcript_path, s)
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


async def get_track_outline(
    track_id: str,
    lang: str = "ru",
    *,
    yield_event: YieldEvent = _noop_yield,
) -> dict[str, Any]:
    """Return outline items + emit `outline` side-event for the client.

    `lang` is the user's preferred outline language; the actual transcript
    we read from may be in a different language if the requested one
    isn't available for this track (e.g. English-only lecture asked for
    in a Russian session). The cache key + emitted payload use the
    effective transcript language so subsequent requests in either
    language land on the same artifact.
    """
    s = get_settings()

    # 1. Resolve which transcript we can actually read. Done first so the
    # rest of the pipeline (HEAD cache key, LLM prompt language, S3 PUT
    # key) all use the same effective language. Empty result = the track
    # has no transcripts at all → unambiguous failure.
    transcript_path, effective_lang = await asyncio.to_thread(
        _resolve_transcript_sync, track_id, lang
    )
    if not transcript_path:
        return {
            "error": "transcript_unavailable",
            "track_id": track_id,
            "lang": lang,
        }

    # 2. Warm path — S3 HEAD/GET under the effective lang's cache key.
    try:
        exists = await asyncio.to_thread(
            outline_exists_sync, track_id, effective_lang, s
        )
    except Exception as exc:
        log.warning(
            "outline_head_failed",
            track_id=track_id, lang=effective_lang, error=str(exc),
        )
        exists = False

    payload: dict[str, Any] | None = None
    if exists:
        try:
            payload = await asyncio.to_thread(
                get_outline_sync, track_id, effective_lang, s
            )
        except Exception as exc:
            log.warning(
                "outline_get_failed",
                track_id=track_id, lang=effective_lang, error=str(exc),
            )
            payload = None

    # 3. Cold path — generate + persist.
    if payload is None:
        async with _OUTLINE_LOCKS[(track_id, effective_lang)]:
            # Re-check inside the lock — another coroutine in this process
            # may have just written it while we were queued.
            try:
                exists_after_lock = await asyncio.to_thread(
                    outline_exists_sync, track_id, effective_lang, s,
                )
            except Exception as exc:
                log.warning(
                    "outline_head_failed_in_lock",
                    track_id=track_id, lang=effective_lang, error=str(exc),
                )
                exists_after_lock = False
            if exists_after_lock:
                try:
                    payload = await asyncio.to_thread(
                        get_outline_sync, track_id, effective_lang, s
                    )
                except Exception as exc:
                    log.warning(
                        "outline_get_failed_in_lock",
                        track_id=track_id, lang=effective_lang, error=str(exc),
                    )

            if payload is None:
                try:
                    payload = await _generate_outline(
                        track_id, transcript_path, effective_lang, settings_=s
                    )
                except RuntimeError as exc:
                    return {
                        "error": str(exc),
                        "track_id": track_id,
                        "lang": effective_lang,
                    }
                # Conditional PUT — refuses to overwrite if another worker
                # (different pod / process) wrote the artifact while we
                # were running gemini-flash. On loss, refetch theirs.
                try:
                    await asyncio.to_thread(
                        put_outline_sync, track_id, effective_lang, payload, s,
                        if_none_match=True,
                    )
                except OutlineAlreadyExists:
                    log.info(
                        "outline_put_lost_race",
                        track_id=track_id, lang=effective_lang,
                    )
                    try:
                        payload = await asyncio.to_thread(
                            get_outline_sync, track_id, effective_lang, s,
                        )
                    except Exception as exc:
                        log.warning(
                            "outline_get_after_race_failed",
                            track_id=track_id, lang=effective_lang, error=str(exc),
                        )
                except Exception as exc:
                    # Persist failure isn't fatal — the user still gets the outline.
                    log.warning(
                        "outline_put_failed",
                        track_id=track_id, lang=effective_lang, error=str(exc),
                    )

    items = payload.get("items") or []
    yield_event("outline", {"track_id": track_id, "items": items})
    return {
        "track_id": track_id,
        "lang": effective_lang,
        "items": items,
        "marker": f"[outline:{track_id}]",
    }


TOOL_REGISTRY = [
    {
        "name": "get_track_outline",
        "fn": get_track_outline,
        "personalized": False,
        "emits_events": True,
        "description": (
            "Generate (or fetch cached) outline for a track: 5-8 chapter-like "
            "items with timecodes (start_ms) and titles. Use when the user asks "
            "for a summary, the contents of a lecture, or 'recap what I just "
            "listened to'. After calling, embed the marker '[outline:<track_id>]' "
            "in your reply where the outline card should render — the client "
            "mounts an interactive list at that position."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "track_id": {"type": "string"},
                "lang": {"type": "string", "enum": ["ru", "en"]},
            },
            "required": ["track_id"],
        },
    },
]
