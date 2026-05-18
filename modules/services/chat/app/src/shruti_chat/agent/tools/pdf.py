"""generate_track_pdf — render + cache a transcript PDF per track.

Flow per (track_id, lang):
1. Catalog → resolve transcript path + effective lang.
2. PdfStorage → HEAD; if hit, reuse the public URL.
3. Cold path → fetch transcript, best-effort fetch cached outline,
   render PDF, upload, return URL.

The tool always emits a single `action` side-event of kind `share_pdf`
with one row per successfully-prepared track. The mobile client mounts a
share-sheet card from that payload; the LLM embeds
`[action:share_pdf|id=<action_id>]` inline where the card should land.

`track_ids` is a list — the tool accepts a single id or a small batch
without forcing the LLM to dispatch the tool N times. Hard cap on batch
size keeps the worst case (gen N PDFs serially) bounded.
"""

from __future__ import annotations

import asyncio
import re
import secrets
from typing import Any, Callable

from shruti_chat.agent.tools._registry import ToolDef, register_tool
from shruti_chat.agent.tools.outline import ensure_outline_payload
from shruti_chat.domain.entities import Track
from shruti_chat.domain.ports.catalog_repository import CatalogRepository
from shruti_chat.domain.ports.outline_cache import OutlineCache
from shruti_chat.domain.ports.pdf_storage import PdfStorage
from shruti_chat.domain.ports.transcript_storage import TranscriptStorage
from shruti_chat.infra.pdf import render_transcript_pdf
from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


YieldEvent = Callable[[str, dict[str, Any]], None]


def _noop_yield(_type: str, _data: dict[str, Any]) -> None:
    """Fallback when this tool is invoked outside the agent loop (tests)."""


# Hard ceiling on a single dispatch. Each PDF means: 1× catalog query,
# 1× transcript fetch, 1× LLM-free PDF render (~50-500 ms on real
# lectures), 1× S3 PUT. 10 is well above any realistic share-set the
# user would pick and well below where serial rendering becomes
# pathological.
MAX_BATCH = 10

# Cap on concurrent renders to bound peak CPU/memory inside the worker.
_RENDER_CONCURRENCY = 3


def _new_action_id() -> str:
    """Stable, opaque token for the action marker. Hex (no URL-unsafe
    characters) so it round-trips cleanly through the marker grammar."""
    return secrets.token_hex(4)


async def _prepare_one(
    *,
    track_id: str,
    requested_lang: str,
    catalog_repo: CatalogRepository,
    transcript_storage: TranscriptStorage,
    outline_cache: OutlineCache,
    pdf_storage: PdfStorage,
) -> dict[str, Any]:
    """Resolve, render-if-needed, and return the wire dict for one track.

    Returns one of:
      `{track_id, lang, title, author, pdf_url}` on success
      `{track_id, error: "..."}`                  on a recoverable failure
    """
    transcript_path, effective_lang = await catalog_repo.resolve_transcript_path(
        track_id, requested_lang=requested_lang,
    )
    if not transcript_path:
        return {"track_id": track_id, "error": "transcript_unavailable"}

    # Warm path — artifact already on the CDN.
    try:
        already = await pdf_storage.head(track_id, effective_lang)
    except Exception as exc:
        log.warning(
            "pdf_head_failed",
            track_id=track_id, lang=effective_lang, error=str(exc),
        )
        already = False
    if already:
        track = await catalog_repo.get_track(track_id, lang=effective_lang)
        if track is None:
            return {"track_id": track_id, "error": "track_not_found"}
        return _wire(
            track, effective_lang,
            pdf_storage.public_url(track_id, effective_lang),
        )

    # Cold path. We need: track metadata, transcript JSON, optional outline.
    track = await catalog_repo.get_track(track_id, lang=effective_lang)
    if track is None:
        return {"track_id": track_id, "error": "track_not_found"}

    try:
        transcript = await transcript_storage.fetch(transcript_path)
    except Exception as exc:
        log.warning(
            "pdf_transcript_fetch_failed",
            track_id=track_id, lang=effective_lang, path=transcript_path,
            error=str(exc),
        )
        return {"track_id": track_id, "error": "transcript_fetch_failed"}

    # Outline drives both the cover TOC and the section-anchored
    # paragraph splits in the body. On cache miss we generate it
    # here (same logic as `get_track_outline`) so the PDF always
    # gets the structured layout. `ensure_outline_payload` returns
    # `None` on any failure — we render an outline-less PDF as the
    # graceful degradation.
    outline = await ensure_outline_payload(
        track_id, transcript_path, effective_lang,
        transcript_storage=transcript_storage,
        outline_cache=outline_cache,
    )

    try:
        pdf_bytes = await asyncio.to_thread(
            render_transcript_pdf,
            track=track, transcript=transcript, outline=outline, lang=effective_lang,
        )
    except Exception as exc:
        log.exception(
            "pdf_render_failed",
            track_id=track_id, lang=effective_lang, error=str(exc),
        )
        return {"track_id": track_id, "error": "render_failed"}

    try:
        pdf_url = await pdf_storage.put(
            track_id, effective_lang, pdf_bytes,
            download_filename=_share_filename(track, effective_lang),
        )
    except Exception as exc:
        log.exception(
            "pdf_upload_failed",
            track_id=track_id, lang=effective_lang, error=str(exc),
        )
        return {"track_id": track_id, "error": "upload_failed"}

    return _wire(track, effective_lang, pdf_url)


def _wire(track: Track, lang: str, pdf_url: str) -> dict[str, Any]:
    return {
        "track_id": track.id,
        "lang": lang,
        "title": track.title or track.id,
        "author": track.author_name or track.author_id,
        "date": track.date,
        "pdf_url": pdf_url,
    }


# Filesystem-unsafe characters Windows + macOS reject in share targets;
# Cyrillic and IAST diacritics pass through untouched.
_BAD_FNAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _share_filename(track: Track, lang: str) -> str:
    """Human-readable filename for the artifact's `Content-Disposition`.

    Format: `<title> (<date>).pdf` (date dropped when absent). Fallback
    to `<track_id>.<lang>.pdf` for unnamed tracks. The mobile client
    typically caches the file under its own short filename anyway —
    this only governs what a direct browser download lands as.
    """
    base = (track.title or "").strip() or track.id
    safe = _BAD_FNAME_CHARS.sub("", base)
    safe = re.sub(r"\s+", " ", safe).strip()[:80] or track.id
    if track.date:
        safe = f"{safe} ({track.date})"
    return f"{safe}.pdf"


async def generate_track_pdf(
    track_ids: list[str],
    lang: str = "ru",
    *,
    yield_event: YieldEvent = _noop_yield,
    catalog_repo: CatalogRepository,
    transcript_storage: TranscriptStorage,
    outline_cache: OutlineCache,
    pdf_storage: PdfStorage,
) -> dict[str, Any]:
    # De-dup + cap upfront so the rest of the function works on a stable
    # set. Maintaining input order keeps the share card visually aligned
    # with whatever the user just saw in the chat above.
    seen: set[str] = set()
    cleaned: list[str] = []
    for tid in track_ids or []:
        if not isinstance(tid, str) or not tid.strip():
            continue
        tid = tid.strip()
        if tid in seen:
            continue
        seen.add(tid)
        cleaned.append(tid)
        if len(cleaned) >= MAX_BATCH:
            break

    if not cleaned:
        return {"error": "track_ids_required"}

    sem = asyncio.Semaphore(_RENDER_CONCURRENCY)

    async def _run(tid: str) -> dict[str, Any]:
        async with sem:
            return await _prepare_one(
                track_id=tid,
                requested_lang=lang,
                catalog_repo=catalog_repo,
                transcript_storage=transcript_storage,
                outline_cache=outline_cache,
                pdf_storage=pdf_storage,
            )

    results = await asyncio.gather(*[_run(tid) for tid in cleaned])
    ok_items = [r for r in results if "pdf_url" in r]
    errors = [r for r in results if "error" in r]

    if not ok_items:
        return {
            "error": "no_pdfs_prepared",
            "details": errors,
        }

    action_id = _new_action_id()
    yield_event(
        "action",
        {
            "kind": "share_pdf",
            "id": action_id,
            "items": ok_items,
        },
    )
    return {
        "ok": True,
        "action_id": action_id,
        "items": ok_items,
        "errors": errors,
    }


register_tool(ToolDef(
    name="generate_track_pdf",
    fn=generate_track_pdf,
    emits_events=True,
    description=(
        "Render and cache printable PDF(s) of full lecture transcripts (cover "
        "+ optional table of contents + time-coded body). Returns public "
        "https URLs the user can download or share. Use when the user asks "
        "for «pdf / скачать / поделиться лекцией / share the lecture / "
        "download the transcript» on one or more tracks. Pass the "
        "`track_ids` of every lecture the user wants — the tool fans out "
        "and reuses already-cached PDFs (cap 10 per call). After calling, "
        "embed the marker `[action:share_pdf|id=<action_id>]` inline in your "
        "reply where the share card should render — DO NOT also emit "
        "`[card:...]` for the same tracks, the share card lists them itself."
    ),
    parameters={
        "type": "object",
        "properties": {
            "track_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Track ids to prepare PDFs for. 1 to 10.",
            },
            "lang": {
                "type": "string",
                "enum": ["ru", "en"],
                "description": "Preferred transcript language. The tool falls "
                               "back to any available language per track.",
            },
        },
        "required": ["track_ids"],
    },
))
