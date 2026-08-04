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

from lectorium_chat.domain.entities import Message
from lectorium_chat.observability.langfuse_client import prompt_with_fallback
from lectorium_chat.observability.logging import get_logger
from lectorium_chat.research.models import (
    Outline,
    Thesis,
)


log = get_logger(__name__)

_PROMPT_PATH = (
    Path(__file__).parent.parent / "agent" / "prompts" / "synthesis_planner.md"
)
_CONCLUSION_PROMPT_PATH = (
    Path(__file__).parent.parent / "agent" / "prompts" / "conclusion_writer.md"
)
_INTRO_PROMPT_PATH = (
    Path(__file__).parent.parent / "agent" / "prompts" / "intro_writer.md"
)

# Conclusion fallback fires only when the answer has at least this many
# theses — kept in lockstep with `_MIN_THESES_FOR_INTRO` so a multi-thesis
# answer always carries BOTH bookends or neither. A two-thesis answer with
# an intro but no conclusion reads lopsided; the symmetry is the point.
_MIN_THESES_FOR_CONCLUSION = 2

# The intro is rewritten by a dedicated post-outline pass for answers with
# at least this many theses. Single-thesis answers carry no intro (the lone
# paragraph speaks for itself) — matches the planner prompt's own rule.
_MIN_THESES_FOR_INTRO = 2


def _load_prompt() -> str:
    return _PROMPT_PATH.read_text(encoding="utf-8")


def _load_conclusion_prompt() -> str:
    return _CONCLUSION_PROMPT_PATH.read_text(encoding="utf-8")


def _load_intro_prompt() -> str:
    return _INTRO_PROMPT_PATH.read_text(encoding="utf-8")


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


def _lang_directive(lang: str, lang_name: str | None) -> str:
    """Render the `Language:` directive value.

    A bare locale code ("sr-Latn") makes the LLM drift to Russian; the
    synthesizer fixes this by resolving the human language NAME from the
    catalog `languages` table and so do the planner-side writers. When the
    name resolves we emit `Srpski (sr-Latn)`; otherwise fall back to the
    bare code so the directive is never empty.
    """
    if lang_name:
        return f"{lang_name} ({lang})"
    return lang


def _format_user(
    question: str,
    lang: str,
    notes: list[dict[str, Any]],
    *,
    lang_name: str | None = None,
    memory_notes: list[str] | None = None,
    speaker: str = "",
) -> str:
    note_blocks = "\n\n".join(
        _render_note(i, n) for i, n in enumerate(notes, start=1)
    )
    curator_block = ""
    if memory_notes:
        rendered = "\n\n".join(
            f"[Curator note {i}]\n{txt.strip()}"
            for i, txt in enumerate((t for t in memory_notes if t and t.strip()), start=1)
        )
        if rendered:
            curator_block = (
                "Curator notes (AUTHORITATIVE framing — ANCHOR the outline to "
                "these; see the \"Curator note\" rule):\n"
                f"{rendered}\n\n"
            )
    # WHOSE words the lecture notes are. The planner cannot tell from the text —
    # a transcript fragment rarely names its own speaker — so on «что X говорил о
    # карме» it judged every fragment off-topic and rejected all thirteen notes,
    # including five of X's own. Retrieval had already narrowed the lane to that
    # teacher, so this is a fact we hold and simply never passed on.
    speaker_block = (
        f"Every note of type `lecture` below is SPOKEN BY {speaker}. The question "
        f"asks what {speaker} said, so those notes are the primary evidence — do "
        f"not reject them for failing to name the speaker in their text.\n\n"
        if speaker else ""
    )
    return (
        f"Question: {json.dumps(question, ensure_ascii=False)}\n"
        f"Language: {_lang_directive(lang, lang_name)}\n\n"
        f"{speaker_block}"
        f"{curator_block}"
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
    lang_name: str | None = None,
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
        f"Language: {_lang_directive(lang, lang_name)}\n\n"
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
        conclusion = await llm.text_completion(
            messages, model=effective_model, run_name="conclusion_writer",
        )
    except Exception as exc:  # noqa: BLE001 — best-effort
        log.warning(
            "conclusion_writer_failed",
            error=str(exc),
            n_theses=len(outline.theses),
        )
        return outline

    cleaned = (conclusion or "").strip()
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


async def synthesize_intro(
    outline: Outline,
    lang: str,
    *,
    llm: Any,
    model: str | None = None,
    callbacks: list[Any] | None = None,
    lang_name: str | None = None,
    memory_notes: list[str] | None = None,
) -> str | None:
    """Write the intro from the FINISHED theses, in a dedicated pass.

    The planner emits `intro` inline, before it has written the theses, so
    that intro can only echo the topics/headers — a "we'll look at A, B, C"
    table of contents. This pass runs AFTER the theses are fixed and feeds
    only their claim text to a focused prompt, so the result states what the
    answer actually concludes.

    Returns the new intro string, or `None` on failure / empty return /
    unexpected shape — the caller then keeps whatever intro the planner
    produced. Pure (reads `outline.theses`, mutates nothing), so the caller
    can run it concurrently with the Stage 1/2 grounding work.
    """
    theses_block = "\n".join(
        f"  {i+1}. {t.thesis}" for i, t in enumerate(outline.theses)
    )
    curator_block = ""
    if memory_notes:
        rendered = "\n\n".join(
            f"[Curator note {i}]\n{txt.strip()}"
            for i, txt in enumerate((t for t in memory_notes if t and t.strip()), start=1)
        )
        if rendered:
            curator_block = (
                "Curator notes (the answer's intended overarching framing — "
                "see the \"Curator note\" rule):\n"
                f"{rendered}\n\n"
            )
    user_msg = (
        f"Language: {_lang_directive(lang, lang_name)}\n\n"
        f"{curator_block}"
        f"Theses:\n{theses_block}"
    )

    try:
        prompt = prompt_with_fallback(
            "intro-writer", fallback=_load_intro_prompt,
        )
        effective_model = prompt.config.get("model") or model
        messages: list[Message] = [
            {"role": "system", "content": prompt.text},
            {"role": "user", "content": user_msg},
        ]
        intro = await llm.text_completion(
            messages, model=effective_model, run_name="intro_writer",
        )
    except Exception as exc:  # noqa: BLE001 — best-effort
        log.warning(
            "intro_writer_failed",
            error=str(exc),
            n_theses=len(outline.theses),
        )
        return None

    cleaned = (intro or "").strip()
    if not cleaned:
        # Writer signalled "no intro adds value" — keep the planner's.
        log.info("intro_writer_returned_empty", n_theses=len(outline.theses))
        return None

    log.info(
        "intro_writer_filled",
        n_theses=len(outline.theses),
        chars=len(cleaned),
    )
    return cleaned


async def build_outline(
    question: str,
    lang: str,
    notes: list[dict[str, Any]],
    *,
    llm: Any,
    model: str | None = None,
    conclusion_model: str | None = None,
    callbacks: list[Any] | None = None,
    lang_name: str | None = None,
    memory_notes: list[str] | None = None,
    speaker: str = "",
) -> Outline | None:
    """Run one structured-output LLM call. Returns:

    - `None` on LLM failure (caller falls back to free-form synthesis).
    - `Outline(theses=[])` when the planner deliberately rejected all
      notes (caller emits refusal).
    - `Outline(theses=[...])` when the planner proposed a structured plan.

    `memory_notes` (curator-authored framing notes for this turn, if any) are
    handed to the planner as AUTHORITATIVE structure: the planner anchors the
    outline to each note's internal steps (note step → thesis) and attaches the
    curator's picked scriptures (already present among `notes`) to the matching
    thesis. See the "Curator note" rule in the planner prompt. The note itself
    is never a `supporting_notes` index — it shapes which theses exist, not the
    evidence.

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
            {
                "role": "user",
                "content": _format_user(
                    question, lang, notes, lang_name=lang_name,
                    memory_notes=memory_notes, speaker=speaker,
                ),
            },
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
    planner_gave_conclusion = bool(
        outline.conclusion and outline.conclusion.strip()
    )
    needs_conclusion = (
        len(outline.theses) >= _MIN_THESES_FOR_CONCLUSION
        and not planner_gave_conclusion
    )
    fallback_outcome = "not_called"
    if needs_conclusion:
        before_conclusion = outline.conclusion
        outline = await _synthesize_conclusion(
            outline, lang, llm=llm,
            model=conclusion_model, callbacks=callbacks,
            lang_name=lang_name,
        )
        if outline.conclusion != before_conclusion and outline.conclusion:
            fallback_outcome = "filled"
        elif outline.conclusion:
            # Defensive — outline.conclusion was already set so the
            # before-comparison didn't catch the filled outcome.
            fallback_outcome = "filled"
        else:
            # _synthesize_conclusion already logs the specific
            # reason (empty-return vs raised); we just summarise here
            # so the conclusion_decision event has a single source-of-truth.
            fallback_outcome = "failed_or_empty"

    if planner_gave_conclusion:
        conclusion_source = "planner"
    elif outline.conclusion:
        conclusion_source = "fallback"
    else:
        conclusion_source = "none"

    log.info(
        "conclusion_decision",
        n_theses=len(outline.theses),
        source=conclusion_source,
        fallback_outcome=fallback_outcome,
    )

    # NOTE: the intro is NOT rewritten here. The planner's inline intro
    # (generated before the theses → a topic table-of-contents) is replaced
    # by `synthesize_intro`, which the synthesis_planner node runs CONCURRENTLY
    # with the Stage 1/2 grounding so the extra LLM call costs ~no wall-clock.
    return outline
