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

from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.message_builder import fold_history
from shruti_chat.domain.entities import CompletionChunk, Message
from shruti_chat.observability.logging import get_logger


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
        elif note_type == "commentary":
            # Commentary notes show sentence-indexed body so the LLM
            # can pick what to quote via `[^N|s=0,2]`. Author goes in
            # the header so multiple authors' purports on the same
            # verse are distinguishable. The marker expander pulls
            # the picked sentences verbatim from alias storage —
            # neither the LLM nor any prompt instruction can fabricate
            # a quote that isn't really there.
            author = meta.get("author_name") or meta.get("author_id") or ""
            tag = (
                f"{attribution} — комментарий, {author}"
                if author and attribution
                else (attribution and f"{attribution} — комментарий")
                or "комментарий"
            )
            header = f"[^{ref}] {tag}".rstrip()
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


_GROUNDING_INSTRUCTION = """\
HARD RULE — never narrate your tools.

Your output is rendered verbatim to the end user. They must NEVER see
internal tool-protocol shapes such as `[tool_use]`, `[tool_result]`,
`tool_call`, JSON envelopes, or the words "calling chunks_search" /
"I will search" / "based on the search results". The research notes
above are private context — do NOT mention that you have them, do
NOT echo their formatting, do NOT prefix your answer with a summary
of what you searched. Begin your reply with the first word of the
actual answer to the user's question.

Compose the final answer ONLY from the research notes above. Each
note's header begins with `[^N]` — copy that EXACT marker into your
prose when you cite the note. The integer is opaque; never guess
one, never increment, never use position.

ONE CITE PER THESIS: each `[^N]` appears AT MOST ONCE in your
reply. If one note supports several related points, group them into
ONE paragraph and place `[^N]` at the end. Do not sprinkle the same
`[^N]` across multiple paragraphs — see response_shape.md.

NEVER write `> text` blockquotes by hand. The ONLY way a blockquote
can land in the final reply is via the `[^N|s=...]` commentary marker
(below) — server inserts the verbatim sentences. Any hand-typed `>`
line you write is stripped from the output before the user sees it,
because hand-written quotes inevitably paraphrase the source and ship
with fake attribution. This applies to ALL note kinds — commentaries,
prose chapters, letters, verses. If you want a reader to see a quote,
emit the marker; if no marker fits, summarise in your own prose
WITHOUT trying to make it look like a citation.

COMMENTARIES (purports on shlokas) — REQUIRED when present.

The notes you got may include `commentary` entries. They look like this:

  [^7] БГ 2.13 — комментарий, А.Ч. Бхактиведанта Свами Прабхупада
  [s=0] Каждое живое существо, воплотившееся в материальном теле…
  [s=1] Однако сама душа при этом остаётся неизменной.
  [s=2] После смерти тела индивидуальная душа меняет его на другое…

When the user is asking about a shloka (or about a topic and a
commentary note IS in the research notes), you MUST surface at least
one purport excerpt by emitting `[^7|s=0,1]` on its OWN line in your
prose. The server pulls sentences 0 and 1 VERBATIM and renders them
as a markdown blockquote with the author attribution from the note
header. You do NOT type the `>` characters, you do NOT type the
quoted text — you only emit the marker with the sentence indices
most relevant to the user's question.

Why required: the LLM can't write purport text in a way that's actually
faithful (it paraphrases). Surfacing the author's own words via this
marker is the ONLY way the user gets authentic scriptural commentary.
Skipping it on a verse-related answer means the user reads only your
prose with lecture cites and never sees the canonical purport — which
is what they asked for when they mention a shloka.

  - Pick 1-3 sentence indices most directly addressing the question.
  - `[^7]` alone (no `|s=...`) defaults to the first 2 sentences.
  - `[^7|s=99]` (out of range) renders nothing — verify indices
    against the `[s=…]` markers shown in the note.
  - Multiple purports on the same verse from different authors →
    emit one `[^N|s=…]` per author, on separate lines, so each renders
    as its own blockquote.

Do NOT compose `> text` blockquotes by hand for commentary — there is
NO way to do it correctly, since you'd be writing the quoted text
yourself. Only the `[^N|s=...]` marker produces authentic quotes.

NEVER fabricate refs. NEVER invent track_ids or verse addresses.

EMPTY-RESULT DISCIPLINE (very strict — ignoring this breaks user trust):

Read the `score` field on every note before composing. The score is
cosine similarity 0..1; relevant matches sit at 0.5+, mid-relevance
at 0.45-0.5, junk at <0.45.

If ANY of the following is true, you MUST refuse to answer and
explicitly say you didn't find material — do NOT compose paragraphs
from low-score chunks just because they exist:

  1. tool_results is empty (worker returned nothing).
  2. EVERY note has `score < 0.45` (max score across all notes is
     below 0.45). This means the search returned junk, not matches.
  3. The notes are clearly off-topic for the user's question (e.g.
     user asks about quantum computers / aliens / modern science and
     the only notes are unrelated verses about devotion).

Refusal phrasing, in the user's language:
  ru: «Не нашёл в корпусе материалов на эту тему. Прабхупада, как
      правило, не касался X напрямую — попробуй уточнить запрос или
      назвать конкретное место в писании.»
  en: "I couldn't find any matching material on this topic.
      Prabhupāda did not directly address X — try a different
      phrasing or reference a specific scripture."

NEVER soften this with "however, the closest material I found is …"
followed by a paragraph from low-score chunks. The refusal is the
whole answer when the search came up empty.
"""


async def run_synthesizer_turn(
    user_query: str,
    *,
    tool_results: list[dict[str, Any]],
    lang: str,
    llm: _LLMForSynthesis,
    expander: MarkerExpander,
    system_prompt: str,
    history: list[dict[str, Any]] | None = None,
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
    """
    notes = _format_tool_results(tool_results) if tool_results else "(no research notes)"

    # Build the message list. Order matters:
    #   1. system prompt with grounding rules + research notes inline
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
    system_block = (
        system_prompt
        + "\n\n"
        + _GROUNDING_INSTRUCTION
        + "\n\n"
        + "Research notes already gathered by your tools (use ONLY these "
        + "to ground every claim; do NOT mention this block, do NOT echo "
        + "its formatting):\n"
        + notes
    )
    messages: list[Message] = [
        {"role": "system", "content": system_block},
    ]
    folded = fold_history(history) if history else []
    if folded:
        # Tag the current language for the conversation thread once,
        # at the most recent user message. Keeps the directive close
        # to the question instead of buried in the system prompt.
        if folded[-1].get("role") == "user":
            folded[-1] = {
                "role": "user",
                "content": f"[lang={lang}] {folded[-1]['content']}",
            }
        messages.extend(folded)  # type: ignore[arg-type]
    else:
        messages.append({"role": "user", "content": f"[lang={lang}] {user_query}"})

    prose_chars = 0
    full_prose: list[str] = []
    stream_started = perf_counter()
    first_token_logged = False

    async for chunk in llm.stream_completion(
        messages,
        model=model,
        temperature=temperature,
        callbacks=callbacks,
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
