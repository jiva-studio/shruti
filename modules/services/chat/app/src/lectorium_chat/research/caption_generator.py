"""caption_generator — single batched LLM call producing short 2-5
word topic tags for the audio fragments cited in this turn.

Runs in the BACKGROUND (parallel to synthesizer streaming) so the
extra latency doesn't add to user-visible TTFT. Writes captions into
a mutable dict shared with `TurnAliasMap.captions`. The
`MarkerExpander` reads `aliases.captions.get(n, "")` when expanding
`[^N]` → `[cite:track@s-e|caption]` — if the slot isn't filled by
the time the LLM emits a marker, the audio chip renders without a
caption (widget still shows title + timestamp). Graceful
degradation, no locking required because dict assignment is atomic.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from lectorium_chat.domain.entities import Message
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


_PROMPT_PATH = (
    Path(__file__).parent.parent / "agent" / "prompts" / "caption_generator.md"
)


class _CaptionResult(BaseModel):
    """LLM output shape: {alias_int_as_str: caption_text, …}."""

    captions: dict[str, str] = Field(default_factory=dict)


def _load_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def _format_user(
    user_question: str,
    lang: str,
    chunks: list[tuple[int, str]],
) -> str:
    payload = {
        "lang": lang,
        "question": user_question,
        "chunks": {str(n): text[:400] for n, text in chunks},
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


async def generate_captions(
    chunks_to_caption: list[tuple[int, str]],
    *,
    user_question: str,
    lang: str,
    llm: Any,
    captions_out: dict[int, str],
    model: str | None = None,
    request_id: str | None = None,
) -> None:
    """Fire-and-forget: one Flash-Lite call covers all chunks, results
    are written into `captions_out` (the shared `TurnAliasMap.captions`
    dict). On any failure the captions stay empty and audio chips
    degrade gracefully.

    `chunks_to_caption` is a list of `(alias_int, chunk_text_snippet)`
    tuples — only lecture-FRAGMENT aliases (ChunkRef with timestamps)
    benefit from captions; verse / whole-track aliases don't use this
    map. The caller pre-filters."""
    if not chunks_to_caption:
        return

    try:
        messages: list[Message] = [
            {"role": "system", "content": _load_prompt()},
            {"role": "user", "content": _format_user(user_question, lang, chunks_to_caption)},
        ]
        result: _CaptionResult = await llm.structured_output(
            messages, _CaptionResult, model=model,
        )
        written = 0
        for k, v in result.captions.items():
            try:
                n = int(k)
            except (TypeError, ValueError):
                continue
            caption = (v or "").strip()
            if not caption:
                continue
            captions_out[n] = caption
            written += 1
        log.info(
            "caption_generator_done",
            request_id=request_id,
            requested=len(chunks_to_caption),
            written=written,
        )
    except (ValidationError, Exception) as exc:  # noqa: BLE001 — best-effort
        log.warning(
            "caption_generator_failed",
            request_id=request_id,
            error=str(exc),
            requested=len(chunks_to_caption),
        )
