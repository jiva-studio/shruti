"""outline_builder — single LLM call producing a structured Outline.

Sits between `research_worker` (which fanned out and gathered notes) and
the `synthesizer` (which streams the final prose). Decides:

1. Which notes are actually relevant (filters score-< 0.45 / off-topic).
2. How to group the survivors into 1-5 focused theses.
3. Which note indices back each thesis.

The synthesizer then writes one paragraph per thesis, citing only the
attributed notes. Empty `theses` is the explicit "no relevant material"
signal — caller emits a refusal. `None` return means the planner LLM
itself failed; caller falls back to free-form synthesis on the raw
notes (legacy behaviour).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from shruti_chat.domain.entities import Message
from shruti_chat.observability.langfuse_client import prompt_with_fallback
from shruti_chat.observability.logging import get_logger
from shruti_chat.research.models import ConclusionResponse, Outline, Thesis


log = get_logger(__name__)

_PROMPT_PATH = (
    Path(__file__).parent.parent / "agent" / "prompts" / "synthesis_planner.md"
)
_CONCLUSION_PROMPT_PATH = (
    Path(__file__).parent.parent / "agent" / "prompts" / "conclusion_writer.md"
)

# Conclusion fallback fires only when the answer has at least this many
# theses. Single + double-thesis answers don't need a closing paragraph;
# the reader can hold the through-line in mind.
_MIN_THESES_FOR_CONCLUSION = 3


def _load_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def _load_conclusion_prompt() -> str:
    return _CONCLUSION_PROMPT_PATH.read_text(encoding="utf-8")


def _render_note(idx: int, note: dict[str, Any]) -> str:
    """Render one note as a compact LLM-facing block.

    `idx` is the 1-based marker the planner must use in `supporting_notes`
    — matches what the synthesizer will see in its own notes section.
    """
    note_type = note.get("type", "?")
    label = (note.get("label") or "").strip()
    text = (note.get("text") or "").strip()
    score = note.get("score")
    meta = note.get("meta") or {}
    # sub_query_id absent on persisted history (pre-Phase-A turns) —
    # the prompt says to treat missing as 'general'.
    sub_query_id = meta.get("sub_query_id")
    sub_query_type = meta.get("sub_query_type")

    header_parts = [f"[^{idx}]", f"type={note_type}"]
    if label:
        header_parts.append(f"label={json.dumps(label, ensure_ascii=False)}")
    if isinstance(score, (int, float)):
        header_parts.append(f"score={round(float(score), 2)}")
    if sub_query_type is not None:
        header_parts.append(f"sub_query_type={sub_query_type}")
    elif sub_query_id is not None:
        # Phase A wrote sub_query_id but not type — emit as opaque id so
        # the planner can still group, even without the human label.
        header_parts.append(f"sub_query_id={sub_query_id}")
    # else: legacy note, no group hint — planner treats as general.

    header = " ".join(header_parts)
    if not text:
        return header
    # Trim text aggressively — the planner cares about topic, not full
    # content. Synthesizer sees the full text downstream.
    if len(text) > 600:
        text = text[:597].rstrip() + "…"
    return f"{header}\n{text}"


def _format_user(question: str, lang: str, notes: list[dict[str, Any]]) -> str:
    note_blocks = "\n\n".join(
        _render_note(i, n) for i, n in enumerate(notes, start=1)
    )
    return (
        f"Question: {json.dumps(question, ensure_ascii=False)}\n"
        f"Language: {lang}\n\n"
        f"Notes:\n{note_blocks}"
    )


def _filter_broken_refs(outline: Outline, n_notes: int) -> Outline:
    """Drop theses whose `supporting_notes` contain indices outside
    `1..n_notes`. The schema only validates types — only we know how
    many notes the planner actually saw."""
    clean_theses: list[Thesis] = []
    for t in outline.theses:
        valid = [i for i in t.supporting_notes if 1 <= i <= n_notes]
        if not valid:
            log.warning(
                "outline_thesis_dropped_no_valid_refs",
                thesis_chars=len(t.thesis),
                raw_refs=list(t.supporting_notes),
            )
            continue
        if len(valid) != len(t.supporting_notes):
            log.warning(
                "outline_thesis_partial_refs_filtered",
                thesis_chars=len(t.thesis),
                raw_refs=list(t.supporting_notes),
                kept_refs=valid,
            )
        clean_theses.append(Thesis(
            thesis=t.thesis,
            header=t.header,
            supporting_notes=valid,
            sub_query_types=list(t.sub_query_types),
        ))
    return Outline(
        intro=outline.intro,
        theses=clean_theses,
        conclusion=outline.conclusion,
        skipped_notes=list(outline.skipped_notes),
        skipped_reason=outline.skipped_reason,
    )


async def _synthesize_conclusion(
    outline: Outline,
    lang: str,
    *,
    llm: Any,
    model: str | None,
    callbacks: list[Any] | None,
) -> Outline:
    """Server-side fallback: when the planner skips `conclusion` on a 3+
    thesis outline (consistent behaviour of weaker structured-output
    models despite the prompt rule), run a separate cheap LLM call to
    write one. Returns the outline with `conclusion` populated, OR the
    original outline if the call fails or returns an empty string.
    """
    theses_block = "\n".join(
        f"  {i+1}. {t.thesis}" for i, t in enumerate(outline.theses)
    )
    user_msg = (
        f"Language: {lang}\n\n"
        f"Theses:\n{theses_block}"
    )

    try:
        prompt = prompt_with_fallback(
            "conclusion-writer", fallback=_load_conclusion_prompt,
        )
        effective_model = prompt.config.get("model") or model
        messages: list[Message] = [
            {"role": "system", "content": prompt.text},
            {"role": "user", "content": user_msg},
        ]
        response: ConclusionResponse = await llm.structured_output(
            messages, ConclusionResponse,
            model=effective_model, callbacks=callbacks,
            run_name="conclusion_writer",
        )
    except (ValidationError, Exception) as exc:  # noqa: BLE001 — best-effort
        log.warning(
            "conclusion_writer_failed",
            error=str(exc),
            n_theses=len(outline.theses),
        )
        return outline

    cleaned = (response.conclusion or "").strip()
    if not cleaned:
        # Writer signalled "no good conclusion fits" — let the answer
        # end on the last thesis instead of synthesising filler.
        log.info(
            "conclusion_writer_returned_empty",
            n_theses=len(outline.theses),
        )
        return outline

    log.info(
        "conclusion_writer_filled",
        n_theses=len(outline.theses),
        chars=len(cleaned),
    )
    return Outline(
        intro=outline.intro,
        theses=list(outline.theses),
        conclusion=cleaned,
        skipped_notes=list(outline.skipped_notes),
        skipped_reason=outline.skipped_reason,
    )


async def build_outline(
    question: str,
    lang: str,
    notes: list[dict[str, Any]],
    *,
    llm: Any,
    model: str | None = None,
    conclusion_model: str | None = None,
    callbacks: list[Any] | None = None,
) -> Outline | None:
    """Run one structured-output LLM call. Returns:

    - `None` on LLM failure (caller falls back to free-form synthesis).
    - `Outline(theses=[])` when the planner deliberately rejected all
      notes (caller emits refusal).
    - `Outline(theses=[...])` when the planner proposed a structured plan.

    For 3+ thesis outlines where the planner left `conclusion=None`,
    runs a cheap fallback LLM call to synthesise a closing paragraph
    (`_synthesize_conclusion`). The fallback is best-effort: if it
    fails or returns empty, the outline keeps `conclusion=None` and
    the synthesizer just ends on the last thesis.
    """
    if not notes:
        # Nothing to plan over. Emit a deliberate empty outline so the
        # caller's refusal path runs, not the free-form fallback.
        return Outline(theses=[], skipped_reason="no notes provided")

    try:
        prompt = prompt_with_fallback("synthesis-planner", fallback=_load_prompt)
        effective_model = prompt.config.get("model") or model
        messages: list[Message] = [
            {"role": "system", "content": prompt.text},
            {"role": "user", "content": _format_user(question, lang, notes)},
        ]
        outline: Outline = await llm.structured_output(
            messages, Outline,
            model=effective_model, callbacks=callbacks,
            run_name="synthesis_planner",
        )
        outline = _filter_broken_refs(outline, n_notes=len(notes))
    except (ValidationError, Exception) as exc:  # noqa: BLE001 — best-effort
        log.warning(
            "synthesis_planner_failed",
            error=str(exc),
            question_chars=len(question),
            n_notes=len(notes),
        )
        return None

    # Conclusion-synthesis fallback. Only fires on multi-thesis answers
    # where the planner declined to write one — single/double-thesis
    # outlines don't benefit from a closing paragraph and the prompt
    # explicitly says skip them.
    needs_conclusion = (
        len(outline.theses) >= _MIN_THESES_FOR_CONCLUSION
        and not (outline.conclusion and outline.conclusion.strip())
    )
    if needs_conclusion:
        outline = await _synthesize_conclusion(
            outline, lang, llm=llm,
            model=conclusion_model, callbacks=callbacks,
        )

    return outline
