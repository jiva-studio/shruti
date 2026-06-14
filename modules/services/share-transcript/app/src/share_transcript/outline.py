"""Outline (TOC) generation + cache — moved out of the chat service.

`ensure_outline` returns an outline payload (`{items: [{start_ms, title}]}`)
for one (track, lang): cache hit on the S3 artifact, else generate from the
transcript via the LLM and conditionally PUT it back. Any failure returns
`None` so the PDF renders without a TOC rather than failing.

Ported verbatim from the chat agent's `outline.py`; the only change is that
the transcript is passed in (already fetched by the pipeline) instead of
re-fetched, and storage goes through this service's `S3`.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from share_transcript import llm
from share_transcript.config import Settings
from share_transcript.s3 import S3, OutlineConflict

log = logging.getLogger("share_transcript.outline")


_OUTLINE_LOCKS: defaultdict[tuple[str, str], asyncio.Lock] = defaultdict(asyncio.Lock)


_OUTLINE_PROMPT = """You list the topics of one lecture from its time-coded transcript.

Rules:
1. Return a JSON array of objects: {{"start": "MM:SS" or "HH:MM:SS", "title": "..."}}, one per distinct topic, in chronological order. Be granular — emit a new item whenever the topic shifts. A later pass merges these into chapters, so don't worry about the count.
2. title is 3-6 words written in the language with code `{lang}`, sentence case, describing the TOPIC discussed in that segment. Not a quotation.
3. start is a real timecode from the transcript (copy from the [MM:SS] / [HH:MM:SS] markers at the start of lines — don't invent).
4. Don't restate the same topic across items.
5. FORBIDDEN: quote marks, emoji, exclamation/question marks in titles, clickbait phrasing, "Prabhupada explains" / "The lecture about" prefixes — write the topic itself.

Return ONLY a valid JSON array. No wrapper object, no markdown, no commentary."""


# Hard ceiling on chapters. The fine pass above is deliberately granular and
# its count is unstable (often 30–150 items for the same lecture across runs);
# we don't fight that — `_collapse` merges consecutive topics into <= this many
# chapters, repeating up to _MAX_MERGE_PASSES times. The final count emerges
# from the content (a one-theme talk collapses to ~3, a wide-ranging one to
# ~8) instead of a clock or a prompt the model ignores.
_MAX_CHAPTERS = 8
_MAX_MERGE_PASSES = 5

_MERGE_PROMPT = """You merge a fine-grained list of lecture topics into a few coarse chapters.

Input: an ordered list of topics, one per line as "[MM:SS] topic".

Rules:
1. Group CONSECUTIVE topics that share a broader theme into one chapter. Keep the order, cover everything, never reorder or drop a span.
2. Output 3-{max_chapters} chapters total. Fewer is better — if the lecture circles one theme, return fewer.
3. Each chapter: {{"start": "<timecode of the FIRST topic in that group>", "title": "..."}}. title is a 3-6 word theme in language `{lang}`, sentence case, covering the WHOLE group — not a single sub-topic, not a quotation.
4. FORBIDDEN: quote marks, emoji, exclamation/question marks in titles, clickbait phrasing, "Prabhupada explains" / "The lecture about" prefixes.

Return ONLY a valid JSON array. No wrapper object, no markdown, no commentary."""


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


def _build_user_prompt(transcript: dict[str, Any]) -> str:
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


async def _collapse(
    items: list[dict[str, Any]], lang: str, settings: Settings
) -> list[dict[str, Any]]:
    """One merge pass: fold the topic list into a handful of coarse chapters.
    Returns the input unchanged on any failure — a fine-grained outline beats
    none."""
    listing = "\n".join(f"[{_fmt_ts(i['start_ms'])}] {i['title']}" for i in items)
    try:
        resp = await llm.acompletion(
            model=settings.llm_outline,
            messages=[
                {"role": "system", "content": _MERGE_PROMPT.format(max_chapters=_MAX_CHAPTERS, lang=lang)},
                {"role": "user", "content": listing},
            ],
            temperature=0.2,
        )
        merged = _items_from_llm_json(resp.choices[0].message.content or "")
        return merged or items
    except Exception as exc:  # noqa: BLE001 — a failed merge must not lose the outline
        log.warning("outline_merge_failed lang=%s err=%s", lang, exc)
        return items


async def _generate(track_id: str, lang: str, transcript: dict[str, Any], settings: Settings) -> dict[str, Any]:
    resp = await llm.acompletion(
        model=settings.llm_outline,
        messages=[
            {"role": "system", "content": _OUTLINE_PROMPT.format(lang=lang)},
            {"role": "user", "content": _build_user_prompt(transcript)},
        ],
        temperature=0.2,
    )
    text = resp.choices[0].message.content or ""
    items = _items_from_llm_json(text)
    if not items:
        raise RuntimeError("outline_empty")
    items.sort(key=lambda i: i["start_ms"])
    passes = 0
    while len(items) > _MAX_CHAPTERS and passes < _MAX_MERGE_PASSES:
        before = len(items)
        items = await _collapse(items, lang, settings)
        items.sort(key=lambda i: i["start_ms"])
        passes += 1
        if len(items) >= before:  # no progress — don't spin on a stubborn merge
            break
    return {
        "trackId": track_id,
        "language": lang,
        "model": settings.llm_outline,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "items": items,
    }


async def _cache_get_silent(s3: S3, track_id: str, lang: str) -> dict[str, Any] | None:
    try:
        if await s3.outline_exists(track_id, lang):
            return await s3.get_outline(track_id, lang)
    except Exception as exc:  # noqa: BLE001 — cache miss must never fail the render
        log.warning("outline_cache_read_failed track=%s lang=%s err=%s", track_id, lang, exc)
    return None


async def ensure_outline(
    track_id: str,
    lang: str,
    transcript: dict[str, Any],
    s3: S3,
    settings: Settings,
) -> dict[str, Any] | None:
    """Cache-or-generate the outline. Returns None on any failure so the
    PDF still renders (without a TOC)."""
    cached = await _cache_get_silent(s3, track_id, lang)
    if cached is not None:
        return cached

    async with _OUTLINE_LOCKS[(track_id, lang)]:
        cached = await _cache_get_silent(s3, track_id, lang)
        if cached is not None:
            return cached

        try:
            payload = await _generate(track_id, lang, transcript, settings)
        except Exception as exc:  # noqa: BLE001
            log.warning("outline_generate_failed track=%s lang=%s err=%s", track_id, lang, exc)
            return None

        try:
            await s3.put_outline(track_id, lang, payload, if_none_match=True)
        except OutlineConflict:
            refreshed = await _cache_get_silent(s3, track_id, lang)
            if refreshed is not None:
                payload = refreshed
        except Exception as exc:  # noqa: BLE001 — persist failure isn't fatal
            log.warning("outline_put_failed track=%s lang=%s err=%s", track_id, lang, exc)
        return payload
