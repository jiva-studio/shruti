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
from datetime import datetime, timezone
from typing import Any

from lectorium_chat.agent import llm
from lectorium_chat.config import get_settings
from lectorium_chat.indexer.s3 import (
    fetch_transcript,
    get_outline_sync,
    outline_exists_sync,
    put_outline_sync,
)
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.agent.tools._sqlite import catalog_conn

log = get_logger(__name__)


SYSTEM_PROMPT = """Ты помощник, который составляет краткое оглавление лекции по таймкодированному транскрипту.

Правила:
1. Верни JSON-массив из 5-8 объектов: {"start": "MM:SS" или "HH:MM:SS", "title": "..."}.
2. title — 3-7 слов на языке транскрипта, описывает ТЕМУ фрагмента, не цитата.
3. start — реальный таймкод из транскрипта (копируй из меток [MM:SS] / [HH:MM:SS] в начале строк, не выдумывай).
4. Темы должны логически делить лекцию на содержательные части по ходу повествования.
5. Не дублируй смысл между пунктами.

Верни ТОЛЬКО валидный JSON-массив, без обёртки, без markdown, без комментариев."""


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


def _transcript_path_sync(track_id: str, lang: str) -> str | None:
    with catalog_conn() as conn:
        row = conn.execute(
            "SELECT transcript_path FROM track_variants "
            "WHERE track_id = ? AND language = ?",
            (track_id, lang),
        ).fetchone()
    return row["transcript_path"] if row else None


async def _generate_outline(
    track_id: str,
    lang: str,
    settings_=None,
) -> dict[str, Any]:
    """Run LLM on the full transcript. Returns payload ready for S3 PUT."""
    s = settings_ or get_settings()
    transcript_path = await asyncio.to_thread(_transcript_path_sync, track_id, lang)
    if not transcript_path:
        raise RuntimeError("transcript_unavailable")
    transcript = await fetch_transcript(transcript_path, s)
    user_prompt = _build_user_prompt(transcript)

    resp = await llm.acompletion(
        model=s.llm_outline,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
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
        "language": lang,
        "model": s.llm_outline,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "items": items,
    }


async def get_track_outline(
    track_id: str,
    lang: str = "ru",
) -> dict[str, Any]:
    """Return outline items + emit `outline` side-event for the client."""
    s = get_settings()

    # 1. Warm path — S3 HEAD/GET.
    try:
        exists = await asyncio.to_thread(outline_exists_sync, track_id, lang, s)
    except Exception as exc:
        log.warning("outline_head_failed", track_id=track_id, lang=lang, error=str(exc))
        exists = False

    payload: dict[str, Any] | None = None
    if exists:
        try:
            payload = await asyncio.to_thread(get_outline_sync, track_id, lang, s)
        except Exception as exc:
            log.warning("outline_get_failed", track_id=track_id, lang=lang, error=str(exc))
            payload = None

    # 2. Cold path — generate + persist.
    if payload is None:
        try:
            payload = await _generate_outline(track_id, lang, settings_=s)
        except RuntimeError as exc:
            return {
                "error": str(exc),
                "track_id": track_id,
                "lang": lang,
            }
        try:
            await asyncio.to_thread(put_outline_sync, track_id, lang, payload, s)
        except Exception as exc:
            # Persist failure isn't fatal — the user still gets the outline.
            log.warning("outline_put_failed", track_id=track_id, lang=lang, error=str(exc))

    items = payload.get("items") or []
    return {
        "track_id": track_id,
        "lang": lang,
        "items": items,
        "marker": f"[outline:{track_id}]",
        "_side_events": [
            {"type": "outline", "data": {"track_id": track_id, "items": items}},
        ],
    }
