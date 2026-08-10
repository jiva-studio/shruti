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

from lectorium_chat.agent.events import error_event
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


def _build_position_alias_remap(tool_results: list[Any]) -> dict[int, int]:
    """Map each citable note's 1-based POSITION → its alias `ref`.

    Mirrors `_format_tool_results`' flatten + `enumerate(start=1)` exactly,
    so position `i` here is the same number rendered in note `i`'s `[^i]`
    header. The expander uses this to turn the LLM's emitted position token
    back into the alias the payload was minted under. Only integer-`ref`
    notes (verse / lecture / commentary / location — the citable ones) get
    an entry; non-citable blocks (prose_chapter/letter without a ref) are
    skipped, matching the synthesizer's own bare-header rendering.
    """
    flat: list[dict[str, Any]] = []
    for r in tool_results:
        if isinstance(r, list):
            flat.extend(x for x in r if isinstance(x, dict))
        elif isinstance(r, dict):
            flat.append(r)
    remap: dict[int, int] = {}
    for i, note in enumerate(flat, start=1):
        ref = note.get("ref")
        if isinstance(ref, int):
            remap[i] = ref
    return remap


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

    # track_outline_get result: `{track_id, lang, items:[{start_ms, title}]}`.
    # Unlike the citable notes it carries NO `ref` and NO `text` — the chapter
    # headings live in `items`, and the interactive contents list renders
    # client-side from the `[outline:<id>]` marker (the tool already emitted the
    # `outline` action event). Without a branch here the note falls through to
    # the generic path, which produces an EMPTY string (no header, no text) — so
    # the synthesizer sees blank RESEARCH NOTES and refuses with the
    # empty-result discipline even though the recap data is right there. Surface
    # the titles as grounding so the synthesizer can summarise them, and pin the
    # marker it must emit for the card. See agent/tools/outline.py + tools.md.
    outline_items = note.get("items")
    outline_track_id = note.get("track_id")
    if (
        isinstance(outline_items, list)
        and outline_items
        and isinstance(outline_track_id, str)
    ):
        titles = "\n".join(
            f"- {it['title']}"
            for it in outline_items
            if isinstance(it, dict) and it.get("title")
        )
        if titles:
            return (
                "LECTURE OUTLINE (chapter headings of the lecture the user "
                "asked about). Summarise these in 2-4 sentences as the answer "
                "(don't invent topics, don't enumerate the items one by one), "
                f"and place the marker [outline:{outline_track_id}] on its OWN "
                "line where the interactive contents list should render:\n"
                f"{titles}"
            )

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
        # Header marker uses `idx` — the note's 1-based POSITION in the
        # final note list — NOT the alias `ref`. `idx` is the index-space
        # the synthesis planner numbers `supporting_notes` in and the
        # outline directive cites, so the LLM sees ONE consistent set of
        # `[^N]`. The expander's position→alias remap (installed for this
        # stream) maps `idx` back to `ref` before resolving the payload.
        # Aliases are minted in fetch order and don't track note position,
        # so emitting `[^ref]` here would mis-point chips at the wrong
        # lecture / verse / author whenever the two spaces disagree.
        if note_type == "verse":
            # Drop addr_label adjacency — the strongest priming source
            # for "[^N]" → "[^БГ 2.13]" hallucinations. Verse widget
            # on the client renders the address; the LLM doesn't need
            # to see it in the note header.
            header = f"[^{idx}]"
        elif note_type == "media":
            # Media clip note. Bare `[^N]` header — the addr_label
            # ("speaker · date" / title) renders on the client media card
            # from the SSE payload, so keeping it out of the header avoids
            # priming the model to echo it. The DISPLAY `text` below gives
            # the model enough to decide whether the clip backs the point.
            header = f"[^{idx}]"
        elif note_type == "location":
            # Chapter-location note (locate intent). Bare `[^N]` header;
            # `text` carries the book + canto + chapter-range facts the LLM
            # frames its one-line answer around. The chapter TITLES render
            # client-side in `ChapterCard` from the SSE payload, kept out of
            # the header to avoid the verse-style hallucination priming.
            header = f"[^{idx}]"
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
            header = f"[^{idx}]"
            sentences = meta.get("sentences") or []
            if isinstance(sentences, list) and sentences:
                indexed = "\n".join(
                    f"[s={i}] {s}" for i, s in enumerate(sentences)
                )
                return f"{header}\n{indexed}".rstrip()
        else:
            # Lecture fragment or whole-track card — title is natural
            # language, safe to keep adjacent.
            header = f"[^{idx}] {attribution}".rstrip()
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

    When `outline.intro` is None the intro step is simply omitted — the
    model then begins with the first thesis. (The synthesis_planner uses
    exactly this to stream the intro early and hand us an intro-less plan,
    so the intro isn't generated twice — no prompt hint needed.)

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


# Action-card kinds whose note must always reach the synthesizer even
# though no thesis "cites" it — the model has to copy its marker.
# (Mirrors the set inside `_render_one_note`.)
_ACTION_KINDS = {
    "share_pdf",
    "enable_daily_reminder",
    "configure_smart_library",
    "upgrade_to_pro",
}


def _compact_for_outline(
    tool_results: list[Any], outline: Any
) -> tuple[list[Any], Any]:
    """Trim the note pool the synthesizer sees to ONLY the notes the
    outline actually cites (the union of every thesis's supporting_notes),
    plus always-keep action / error notes. Returns `(compacted_notes,
    remapped_outline)` with supporting_notes renumbered into the compacted
    position space so the `[^N]` indices stay aligned with the OUTLINE
    block AND `_build_position_alias_remap` (both re-derive from the same
    flattened list).

    Why: the post-planner stages inflate `tool_results` to 30-90 notes,
    but the synthesizer is instructed to cite only supporting_notes — so
    handing it the whole pool only invites lost-in-the-middle drift and
    off-plan citations. With `outline=None` (free-form) or empty theses
    (refusal) nothing is trimmed; the legacy whole-pool behaviour stands.
    """
    theses = list(getattr(outline, "theses", []) or [])
    if not theses:
        return tool_results, outline  # free-form / refusal — leave as-is

    flat: list[dict[str, Any]] = []
    for r in tool_results:
        if isinstance(r, list):
            flat.extend(x for x in r if isinstance(x, dict))
        elif isinstance(r, dict):
            flat.append(r)
    n = len(flat)

    keep: set[int] = set()
    for t in theses:
        for i in t.supporting_notes:
            if 1 <= i <= n:
                keep.add(i)
    for i, note in enumerate(flat, start=1):
        if "error" in note or (
            isinstance(note.get("kind"), str)
            and isinstance(note.get("action_id"), str)
            and note["kind"] in _ACTION_KINDS
        ):
            keep.add(i)

    if not keep or len(keep) == n:
        return tool_results, outline  # nothing to trim

    # Local import avoids an application→research import at module load.
    from lectorium_chat.research.models import Outline, Thesis

    kept_sorted = sorted(keep)
    remap = {old: new for new, old in enumerate(kept_sorted, start=1)}
    compacted: list[Any] = [flat[old - 1] for old in kept_sorted]

    new_theses: list[Any] = []
    for t in theses:
        new_refs = [remap[i] for i in t.supporting_notes if i in remap]
        if not new_refs:
            # Defensive: a thesis's notes are always in `keep`, but never
            # emit empty supporting_notes (schema min_length=1).
            new_refs = [1]
        new_theses.append(Thesis(
            thesis=t.thesis,
            header=t.header,
            supporting_notes=new_refs,
            sub_query_types=list(getattr(t, "sub_query_types", []) or []),
        ))
    new_outline = Outline(
        intro=getattr(outline, "intro", None),
        theses=new_theses,
        conclusion=getattr(outline, "conclusion", None),
        skipped_notes=list(getattr(outline, "skipped_notes", []) or []),
        skipped_reason=getattr(outline, "skipped_reason", None),
    )
    log.info(
        "synth_pool_compacted",
        before=n,
        after=len(compacted),
        n_theses=len(new_theses),
    )
    return compacted, new_outline


async def run_synthesizer_turn(
    user_query: str,
    *,
    tool_results: list[dict[str, Any]],
    llm: _LLMForSynthesis,
    expander: MarkerExpander,
    system_prompt: str,
    history: list[dict[str, Any]] | None = None,
    outline: Any | None = None,
    memory_note: str | None = None,
    fallback_answer: str | None = None,
    fallback_confidence: str | None = None,
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
    # Trim the pool to only what the outline cites (keeps `[^N]` indices
    # aligned across notes, outline block and the alias remap — all three
    # re-derive from `tool_results`). No-op for free-form / refusal turns.
    if outline is not None and tool_results:
        tool_results, outline = _compact_for_outline(tool_results, outline)

    notes = _format_tool_results(tool_results) if tool_results else "(no research notes)"

    # Install the position→alias remap for THIS stream. The notes section
    # and outline directive both number notes by position (`[^idx]`); the
    # expander resolves those positions back to the real aliases. Cleared
    # in the `finally` so a shared expander never carries the map into a
    # later non-synthesis use. History is folded WITHOUT `[^N]`, so no
    # prior-turn token is mis-mapped.
    expander.set_ref_remap(
        _build_position_alias_remap(tool_results) if tool_results else None
    )

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
    # Curator memory: background context that SHAPES the answer but is NOT a
    # source. It carries no `[^N]` marker, so it is physically uncitable — the
    # only thing to enforce in prose is "don't quote it as scripture". Sits
    # before the numbered notes so the model reads it as ambient framing.
    memory_section = ""
    if memory_note and memory_note.strip():
        memory_section = (
            f"{_SEP}\n"
            f"BACKGROUND CONTEXT (curator briefing — use it to shape and connect "
            f"your answer, but it is NOT a source: it has no [^N], never cite or "
            f"quote it verbatim, and answer in the user's language regardless of "
            f"the language it is written in)\n"
            f"{_SEP}\n"
            f"{memory_note.strip()}\n\n"
        )
    # Out-of-corpus memory-pass draft. When set, this IS the substance of the
    # answer — a from-general-knowledge reply the corpus_fallback node obtained
    # because the corpus had nothing relevant. Unlike the curator `memory_note`
    # (background framing, never reproduced), the model should present this
    # faithfully; the `fallback` prompt section governs the disclaimer and the
    # opportunistic citation of any RESEARCH NOTES the follow-up search found.
    draft_section = ""
    if fallback_answer and fallback_answer.strip():
        # On a LOW self-assessed confidence, instruct extra hedging — the model
        # graded its OWN answer, so this is a soft calibration, never a guarantee.
        hedge = (
            " The source model flagged LOW confidence — hedge explicitly "
            "(«насколько мне известно…» / «as far as I know…») and avoid stating "
            "specific numbers, dates, or names you are unsure of."
            if (fallback_confidence or "").lower() == "low"
            else ""
        )
        draft_section = (
            f"{_SEP}\n"
            f"DRAFT ANSWER (from general knowledge — the corpus had no relevant "
            f"material. Present this faithfully, in the user's language, as the "
            f"substance of your reply; do NOT attach scripture citations to it. "
            f"Cite the RESEARCH NOTES below — if any — with [^N] only where they "
            f"directly support a point.{hedge})\n"
            f"{_SEP}\n"
            f"{fallback_answer.strip()}\n\n"
        )
    system_block = (
        f"{system_prompt}\n\n"
        f"{memory_section}"
        f"{draft_section}"
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
    # Visible-output guards for the empty-completion check below. `prose_chars`
    # counts POST-expansion delta text but includes whitespace; `has_visible`
    # tracks whether any NON-whitespace prose actually reached the client.
    # `emitted_card` tracks whether a card/commentary action was emitted — a
    # turn that renders only a `[verse:N]` card (e.g. show_verse) has no prose
    # yet is a valid answer and must NOT be flagged as an empty failure.
    has_visible = False
    emitted_card = False
    stream_started = perf_counter()
    first_token_logged = False

    try:
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
            # Commentary cards (card-capable clients): the expander queued an
            # `action` payload for each `[commentary:N]` it just produced.
            # Emit them BEFORE the delta that carries the marker so the client
            # has the payload when it renders the card (payload-before-marker,
            # same invariant the worker flushes uphold for verse/cite).
            for action in expander.take_commentary_actions():
                emitted_card = True
                yield SynthesizerEvent(type=action["type"], data=action["data"])
            # Auto-render cards (verse / cite / media / chapter): the expander
            # queued a CardRequest for each marker it produced — the bridge
            # builds + (cited-only) translates + emits each payload, only for
            # the cards actually cited.
            for req in expander.take_card_requests():
                emitted_card = True
                yield SynthesizerEvent(type="card_request", data={"req": req})
            if cleaned:
                prose_chars += len(cleaned)
                if cleaned.strip():
                    has_visible = True
                yield SynthesizerEvent(type="delta", data={"text": cleaned})

        tail = await expander.flush()
        for action in expander.take_commentary_actions():
            emitted_card = True
            yield SynthesizerEvent(type=action["type"], data=action["data"])
        for req in expander.take_card_requests():
            emitted_card = True
            yield SynthesizerEvent(type="card_request", data={"req": req})
        if tail:
            prose_chars += len(tail)
            if tail.strip():
                has_visible = True
            yield SynthesizerEvent(type="delta", data={"text": tail})
    finally:
        # Drop the per-stream remap so a shared expander can't carry a
        # position→alias map into any later use.
        expander.set_ref_remap(None)

    full_text = "".join(full_prose)

    # A completion that produced no VISIBLE answer is not a (blank) reply —
    # it's an upstream failure the streaming layer couldn't recover from (its
    # retry + fallback both came back empty, the provider streamed nothing, or
    # the model emitted only markers/whitespace that the expander consumed into
    # nothing visible). Yielding `done` with empty prose here would let the turn
    # finalize as had_error=False: no quota refund, no client retry, the user
    # silently charged for a blank message. Emit an `error` event instead so the
    # bridge sets had_error and finalize refunds + the client shows "chat
    # temporarily unavailable, try again".
    #
    # Gate on BOTH "no visible non-whitespace prose" AND "no card emitted":
    # a turn that renders only a card (e.g. show_verse streaming a lone
    # `[verse:N]` marker) delivered a real answer and must not be flagged.
    # `full_prose` (raw pre-expansion tokens) is the wrong signal — a
    # refusal shaped as bare markers leaves it non-empty while nothing
    # visible reached the user.
    if not has_visible and not emitted_card:
        log.warning(
            "synth_empty_completion",
            request_id=request_id,
            notes_count=len(tool_results),
        )
        yield SynthesizerEvent(
            type="error", data=error_event("chat_unavailable").data,
        )
        return

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
