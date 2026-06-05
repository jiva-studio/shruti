"""Application use-case: synthesizer — the singular node that streams
the final response to the client.

Reads `tool_results` accumulated by the research worker (or whichever
worker ran), composes a grounded answer, emits delta chunks one
token at a time. Each chunk is fed through `MarkerExpander` so the
integer-ref markers (`[^N]`) the LLM writes are unfolded into their client-facing
form (`[cite:track_X@...]`, `[verse:source_id/tokens|...]`, etc.)
*before* the bytes leave this function.

Pure: no LangGraph imports. The adapter in
`agent/graph/nodes/synthesizer.py` threads `context.expander`,
`context.aliases`, and `context.llm` into this call.
"""

from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter
from typing import Any, AsyncIterator, Protocol

from lectorium_chat.agent.marker_expander import MarkerExpander
from lectorium_chat.agent.message_builder import fold_history
from lectorium_chat.domain.entities import CompletionChunk, Message
from lectorium_chat.observability.logging import get_logger


log = get_logger(__name__)


class _LLMForSynthesis(Protocol):
    async def stream_completion(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str | None = None,
        model: str | None = None,
        temperature: float | None = None,
        callbacks: list[Any] | None = None,
        run_name: str | None = None,
    ) -> AsyncIterator[CompletionChunk]: ...


@dataclass
class SynthesizerEvent:
    """One unit of output. `type` mirrors the SSE event types the
    transport layer will emit:

    - `delta`: a chunk of post-expansion prose for the client
    - `done`: terminal — synthesizer finished. `data` may carry usage
      / final prose for the bypass-marker audit.
    """

    type: str
    data: dict[str, Any]


def _format_tool_results(tool_results: list[Any]) -> str:
    """Render notes as prose paragraphs the LLM can quote from directly.

    `tool_results` is heterogeneous: chunks_search returns `list[dict]`,
    propose_* returns a single `{ok, action_id, ...}` dict, errors land
    as `{error: ...}`. Flatten transparently — every leaf note becomes
    one numbered paragraph.

    Earlier we dumped each result as ``[result N]\\n{...json...}`` —
    that shape mimics Anthropic-style tool_result envelopes and weaker
    models (Gemini Flash Lite specifically) responded by echoing
    ``[tool_use] chunks_search(...)`` / ``[tool_result] [...]`` literally
    as the opening of their reply. The leak made tool plumbing visible
    to the end user.

    The prose shape below has NO bracketed envelopes and NO JSON — every
    note is a numbered paragraph in plain language, so the model sees
    "here are facts I gathered" instead of "here is a tool transcript
    to continue".
    """
    flat: list[dict[str, Any]] = []
    for r in tool_results:
        if isinstance(r, list):
            flat.extend(x for x in r if isinstance(x, dict))
        elif isinstance(r, dict):
            flat.append(r)
        # silently drop anything else — synth has nothing to do with
        # primitives in the result slot.

    if not flat:
        return "(no notes)"
    return "\n\n".join(_render_one_note(i, n) for i, n in enumerate(flat, start=1))


def _render_one_note(idx: int, note: dict[str, Any]) -> str:
    """One note → minimal LLM-facing paragraph.

    Shape by note type:

      Verse with ref (`[^N]` alone — NO addr_label adjacency, the
      shloka address goes via the client-side widget):

          [^5]
          <verse text>

      Lecture with ref (`[^N]` + natural-language title; titles like
      "Утренняя прогулка, 1976-04-03, Бомбей" don't look like shloka
      addresses, no string-stuffing risk):

          [^5] Утренняя прогулка, 1976-04-03, Бомбей
          <chunk text>

      Commentary / prose_chapter / letter (NO ref — quoted as block,
      addr_label kept for blockquote attribution per library.md):

          БГ 2.13, комментарий
          <text>

      Action result (a propose_* tool returned `{ok, kind, action_id}`):

          ACTION CARD READY — copy this marker exactly into your reply,
          on its own line:
          [action:share_pdf|id=ab12cd34]

    Everything the LLM doesn't act on — `kind=`, `lang=`, IDs like
    `source_id` / `author_id` — is dropped. The server-side marker
    expander knows the type via alias resolution.
    """
    if "error" in note:
        return f"(no usable results: {note.get('error')!s})"

    # Action-tool result: emit an explicit "copy this marker" directive.
    # The propose_* tools return `{ok, kind, action_id, ...}`; synth
    # copies the marker character-by-character — no chance to invent
    # the action_id, no chance to omit it.
    action_kind = note.get("kind")
    action_id = note.get("action_id")
    if (
        isinstance(action_kind, str)
        and isinstance(action_id, str)
        and action_kind in {
            "share_pdf",
            "enable_daily_reminder",
            "configure_smart_library",
            "upgrade_to_pro",
        }
    ):
        return (
            "ACTION CARD READY — copy this marker exactly into your reply, "
            "on its own line:\n"
            f"[action:{action_kind}|id={action_id}]"
        )

    ref = note.get("ref")
    note_type = (note.get("type") or "").lower()
    # ChunkEnvelope uses `label`; tracks_list envelope uses `title`.
    label = note.get("label") or note.get("title") or ""
    text = (note.get("text") or "").strip()
    meta = note.get("meta") or {}

    attribution = label or meta.get("addr_label") or ""

    if isinstance(ref, int):
        if note_type == "verse":
            # Drop addr_label adjacency — the strongest priming source
            # for "[^N]" → "[^БГ 2.13]" hallucinations. Verse widget
            # on the client renders the address; the LLM doesn't need
            # to see it in the note header.
            header = f"[^{ref}]"
        elif note_type == "location":
            # Chapter-location note (locate intent). Bare `[^N]` header;
            # `text` carries the book + canto + chapter-range facts the LLM
            # frames its one-line answer around. The chapter TITLES render
            # client-side in `ChapterCard` from the SSE payload, kept out of
            # the header to avoid the verse-style hallucination priming.
            header = f"[^{ref}]"
        elif note_type in ("commentary", "prose_chapter", "letter"):
            # All three quotable document kinds render identically: a bare
            # `[^N]` header + the indexed sentence body, so the LLM can pick
            # `[^N|s=…]` and the marker expander inlines a verbatim blockquote.
            # Bare `[^N]` header — symmetric with the verse case above.
            #
            # Why no `addr_label` / `author` adjacency: weaker models
            # (Gemini Flash, DeepSeek) copy the prose-y header into
            # their final answer as plain text — observed in prod as
            # trailing lines like `БГ 3.9 БГ 12.14 — комментарий ШБ
            # 1.18.17 — комментарий` after the last cited paragraph.
            # The model treats the header pattern as a citation-summary
            # idiom worth imitating.
            #
            # The marker expander already renders the full attribution
            # (`> — А.Ч. Прабхупада, комментарий к БГ 2.13`) server-side
            # from the alias map's stored `addr_label` + `author_name`,
            # so the model never needed to see those tokens to produce
            # correct output — only the temptation to leak them.
            #
            # Multi-author distinguishability (two purports on the same
            # verse) is preserved by the sentence body shown below the
            # header — the LLM picks `[^7|s=0,2]` based on which
            # purport's prose actually backs the thesis, not based on
            # an author-name label.
            header = f"[^{ref}]"
            sentences = meta.get("sentences") or []
            if isinstance(sentences, list) and sentences:
                indexed = "\n".join(
                    f"[s={i}] {s}" for i, s in enumerate(sentences)
                )
                return f"{header}\n{indexed}".rstrip()
        else:
            # Lecture fragment or whole-track card — title is natural
            # language, safe to keep adjacent.
            header = f"[^{ref}] {attribution}".rstrip()
    else:
        # prose_chapter / letter — addr_label drives the markdown
        # blockquote attribution downstream.
        header = attribution

    return f"{header}\n{text}".rstrip() if header else text


_MAX_HEADER_WORDS = 6
_MAX_HEADER_CHARS = 50


def _sanitize_header(raw: str | None) -> str | None:
    """Guard against the LLM emitting an entire thesis sentence as the
    `header` field. The schema is permissive (`str | None`), the prompt
    asks for 3-5 words — but on rich notes the planner sometimes packs
    the whole claim into the header and leaves nothing meaningful for
    the thesis sentence. Drop the header in that case so the synthesizer
    just renders the paragraph without a misleading bold preamble.

    Also strip trailing punctuation (`.`, `…`, `!`, `?`) — a header is a
    label, not a sentence, so it shouldn't end like one.
    """
    if not raw:
        return None
    cleaned = raw.strip().rstrip(".!?…:;")
    if not cleaned:
        return None
    if len(cleaned) > _MAX_HEADER_CHARS:
        log.info(
            "synth_header_dropped_too_long",
            chars=len(cleaned),
            preview=cleaned[:60],
        )
        return None
    if len(cleaned.split()) > _MAX_HEADER_WORDS:
        log.info(
            "synth_header_dropped_too_many_words",
            words=len(cleaned.split()),
            preview=cleaned[:60],
        )
        return None
    return cleaned


def _format_outline_block(outline: Any) -> str:
    """Render an `Outline` (or None) as an LLM-facing block that pins the
    synthesizer to a structured plan. Empty theses → an explicit refusal
    directive so the synthesizer doesn't try to paper over.

    The rendered shape (intro paragraph + per-thesis [optional markdown
    H2 header + paragraph + citation] + optional conclusion paragraph)
    matches the rendering rules in `response_shape.md`. Keeping the
    formatting here (not in models.py) lets the schema stay prompt-
    agnostic and lets us tune the LLM directives without touching the
    Outline model.
    """
    if outline is None:
        return ""
    theses = list(getattr(outline, "theses", []) or [])
    if not theses:
        return (
            "OUTLINE: planner determined none of the retrieved notes are "
            "relevant for the question. Emit a refusal in the user's "
            "language per the grounding rules. Do NOT attempt to compose "
            "an answer from the notes."
        )

    intro = getattr(outline, "intro", None)
    conclusion = getattr(outline, "conclusion", None)

    # This block carries only the per-turn DATA (intro/thesis/conclusion
    # text + supporting_notes indices) and a pointer. HOW to render —
    # paragraph length, per-thesis citation budget, weaving notes into one
    # argument, inter-thesis connectives — lives in `response_shape.md`
    # (a Langfuse-managed section already in the system prompt), so the
    # rules stay in one hot-reloadable place and can't drift against the
    # code the way the old hard-coded "ONE paragraph / EXACTLY ONE [^N]"
    # directive did.
    parts: list[str] = [
        "Render the answer from this plan, following the Response-shape "
        "rules in the system prompt for HOW to develop, weave and cite "
        "each thesis (paragraph length, per-thesis citation budget, "
        "weaving notes into one argument, and inter-thesis connectives all "
        "live there). Use this EXACT structure and order — do NOT add, "
        "merge, skip or reorder theses:"
    ]
    step = 1
    if intro:
        parts.append(
            f'{step}. INTRO paragraph, rendered verbatim, no citation: "{intro}"'
        )
        step += 1
    parts.append(
        f"{step}. Each thesis below, in order: render its header as a `## ` "
        "markdown H2 (when given), then its developed, woven paragraph, "
        "citing ONLY from that thesis's own supporting_notes."
    )
    step += 1
    if conclusion:
        parts.append(
            f'{step}. CONCLUSION paragraph, rendered verbatim, no citation, '
            f'no header: "{conclusion}"'
        )

    parts.append("")  # spacer line before thesis list
    for i, t in enumerate(theses, start=1):
        header = _sanitize_header(getattr(t, "header", None))
        refs = ", ".join(str(n) for n in t.supporting_notes)
        header_line = f' header="{header}"' if header else ""
        parts.append(
            f"  Thesis {i}{header_line} (supporting_notes: {refs}):\n"
            f"    {t.thesis}"
        )

    return "OUTLINE (follow strictly):\n" + "\n".join(parts)


async def run_synthesizer_turn(
    user_query: str,
    *,
    tool_results: list[dict[str, Any]],
    llm: _LLMForSynthesis,
    expander: MarkerExpander,
    system_prompt: str,
    history: list[dict[str, Any]] | None = None,
    outline: Any | None = None,
    request_id: str | None = None,
    model: str | None = None,
    temperature: float | None = 0.5,
    # Langfuse callback for the streaming synth call. The whole streaming
    # generation becomes one span under the per-turn root trace.
    callbacks: list[Any] | None = None,
) -> AsyncIterator[SynthesizerEvent]:
    """Stream the final response. Each yielded `SynthesizerEvent` of
    type `delta` carries already-expanded text — the caller forwards
    it verbatim to the SSE writer.

    `expander` is the shared `MarkerExpander` from `TurnContext`. It
    holds in-flight buffer state across many `feed()` calls; calling
    `flush()` at stream end emits any partial-marker tail.

    `history` (optional) is the prior turns of this conversation
    (including the latest user message). Pass it for multi-turn
    continuity — the synthesizer then sees prior Q&A and can reference
    earlier exchanges ("вернёмся к тому что мы обсуждали"). Prior
    assistant messages' chip markers get folded back to `[^N]`
    form via each entry's persisted `aliases` payload.
    When `history` is None or empty the synth sees only the current
    `user_query` plus the internal research notes.

    `outline` (optional) is a `research.models.Outline` produced by the
    `synthesis_planner` node. Three meaningful values:
      - `None`                 → free-form synthesis (legacy behaviour);
                                 model decides structure from notes.
      - `Outline(theses=[])`   → planner deliberately rejected all notes;
                                 system prompt instructs explicit refusal.
      - `Outline(theses=[…])`  → model writes one paragraph per thesis,
                                 citing only that thesis's supporting_notes.
    """
    notes = _format_tool_results(tool_results) if tool_results else "(no research notes)"

    # Authoritative chapter-location notes (pinned `title` refs) must ALWAYS
    # reach the client as a ChapterCard. The synthesis planner / LLM tends to
    # drop them — a `type=location` note reads as navigational, not as evidence
    # for a thesis — so the curated chapter would silently vanish. Collect their
    # alias ints now; after the stream we deterministically append the `[^N]`
    # for any the model didn't emit (the alias int IS the [^N] number).
    _chapter_refs: list[int] = []
    for _r in tool_results:
        for _n in (_r if isinstance(_r, list) else [_r]):
            if (
                isinstance(_n, dict)
                and (_n.get("type") or "").lower() == "location"
                and isinstance(_n.get("ref"), int)
            ):
                _chapter_refs.append(_n["ref"])

    # Build the message list. Order matters:
    #   1. system prompt with grounding rules + research notes inline
    #      + optional outline block (when provided)
    #   2. prior conversation history (folds chip markers); ends on
    #      the current user message
    #
    # Research notes ride INSIDE the system prompt — never as an
    # `assistant` message. The earlier shape (assistant role carrying
    # `[internal research notes]\n[result N]\n{...}`) caused weaker
    # models to "complete" what looked like a tool-use chain: they
    # echoed `[tool_use] ...` / `[tool_result] ...` literally as the
    # opening of their response, leaking JSON envelopes to the user.
    # Putting the notes in `system` reframes them as ambient context,
    # not a prior turn to continue.
    _SEP = "─" * 66
    outline_block = _format_outline_block(outline)
    outline_section = (
        f"\n\n{_SEP}\n{outline_block}\n{_SEP}" if outline_block else ""
    )
    system_block = (
        f"{system_prompt}\n\n"
        f"{_SEP}\n"
        f"RESEARCH NOTES (private context — do NOT mention or echo)\n"
        f"{_SEP}\n"
        f"{notes}"
        f"{outline_section}"
    )
    messages: list[Message] = [
        {"role": "system", "content": system_block},
    ]
    folded = fold_history(history) if history else []
    if folded:
        messages.extend(folded)  # type: ignore[arg-type]
    else:
        messages.append({"role": "user", "content": user_query})

    prose_chars = 0
    full_prose: list[str] = []
    stream_started = perf_counter()
    first_token_logged = False

    async for chunk in llm.stream_completion(
        messages,
        model=model,
        temperature=temperature,
        callbacks=callbacks,
        run_name="synthesizer_stream",
    ):
        text = chunk.get("text")
        if not text:
            continue
        if not first_token_logged:
            log.info(
                "stage_timing",
                stage="synthesizer_first_token",
                stage_ms=round((perf_counter() - stream_started) * 1000, 1),
                status="ok",
                request_id=request_id,
            )
            first_token_logged = True
        full_prose.append(text)
        cleaned = await expander.feed(text)
        if cleaned:
            prose_chars += len(cleaned)
            yield SynthesizerEvent(type="delta", data={"text": cleaned})

    # Deterministic chapter surface: emit any curated chapter marker the model
    # skipped, so a pinned chapter never silently disappears. Fed through the
    # expander (→ `[chapter:...]`) BEFORE flush, so it joins the stream cleanly.
    if _chapter_refs:
        emitted = "".join(full_prose)
        missing = [r for r in _chapter_refs if f"[^{r}]" not in emitted]
        if missing:
            inject = "\n\n" + "".join(f"[^{r}]" for r in missing)
            full_prose.append(inject)
            cleaned = await expander.feed(inject)
            if cleaned:
                prose_chars += len(cleaned)
                yield SynthesizerEvent(type="delta", data={"text": cleaned})

    tail = await expander.flush()
    if tail:
        prose_chars += len(tail)
        yield SynthesizerEvent(type="delta", data={"text": tail})

    full_text = "".join(full_prose)
    log.info(
        "stage_timing",
        stage="synthesizer_total",
        stage_ms=round((perf_counter() - stream_started) * 1000, 1),
        status="ok",
        request_id=request_id,
    )
    log.info(
        "synth_done",
        request_id=request_id,
        prose_chars=prose_chars,
        notes_count=len(tool_results),
    )
    yield SynthesizerEvent(type="done", data={"prose": full_text})
