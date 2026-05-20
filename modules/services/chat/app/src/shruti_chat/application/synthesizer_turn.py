"""Application use-case: synthesizer — the singular node that streams
the final response to the client.

Reads `tool_results` accumulated by the research worker (or whichever
worker ran), composes a grounded answer, emits delta chunks one
token at a time. Each chunk is fed through `MarkerExpander` so the
integer-ref markers (`[cite:N]`, `[verse:N]`, `[card:N]`,
`[outline:N]`) the LLM writes are unfolded into their client-facing
form (`[cite:track_X@...]`, `[verse:source_id/tokens|...]`, etc.)
*before* the bytes leave this function.

Pure: no LangGraph imports. The adapter in
`agent/graph/nodes/synthesizer.py` threads `context.expander`,
`context.aliases`, and `context.llm` into this call.
"""

from __future__ import annotations

from dataclasses import dataclass
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
    """One note → human-readable paragraph. No brackets, no JSON."""
    if "error" in note:
        return f"Note {idx}: search returned no usable results ({note.get('error')!s})."

    kind = (note.get("type") or "result").replace("_", " ")
    ref = note.get("ref")
    # ChunkEnvelope uses `label`; tracks_list envelope uses `title` —
    # accept either so the synth header always carries a human label.
    label = note.get("label") or note.get("title") or ""
    lang = note.get("lang") or ""
    text = (note.get("text") or "").strip()
    meta = note.get("meta") or {}

    head_bits: list[str] = [f"Note {idx}", f"kind={kind}"]
    if isinstance(ref, int):
        # Expose ref as a prominent `ref=N` field — the synth prompt
        # tells the model to copy this integer into `[cite:N|caption]`
        # / `[verse:N|caption]` / `[card:N]`. The `ref=N` shape is what
        # the model latched onto in the old JSON-dump rendering (where
        # citations worked); the previous "cite as cite-ref N" phrasing
        # was too oblique and the model started dropping markers.
        head_bits.append(f"ref={ref}")
    if label:
        head_bits.append(f"label={label}")
    if lang:
        head_bits.append(f"lang={lang}")

    head = " · ".join(head_bits)

    # Meta lines — fields the model needs to compose attribution
    # (book + verse for library docs, author + date + location for
    # track listings). Pulled from both `meta` sub-dict (library
    # envelope shape) and top-level (tracks_list envelope shape) so a
    # single renderer covers both.
    meta_bits: list[str] = []
    for k in ("source_id", "tokens", "addr_label", "author_id", "doc_date", "start_ms", "end_ms"):
        v = meta.get(k)
        if v not in (None, ""):
            meta_bits.append(f"{k}={v}")
    for k in ("author_name", "location_name", "date", "duration_ms"):
        v = note.get(k)
        if v not in (None, "", []):
            meta_bits.append(f"{k}={v}")
    meta_line = ("; ".join(meta_bits)) if meta_bits else ""

    body = f"{head}\n"
    if meta_line:
        body += f"{meta_line}\n"
    if text:
        body += text
    return body.rstrip()


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

Compose the final answer ONLY from the research notes above. Every
note carries a `ref=<integer>` field — that integer is what you copy
into the citation marker. Cite EVERY note you describe in prose; an
ungrounded paragraph (description without a marker) is a regression.

Markers by note kind:
- `kind=lecture` + `ref=N` → write `[cite:N|caption]` AND/OR `[card:N]`
  (use card when you're recommending the whole lecture, cite when
  you're quoting a specific moment inside it)
- `kind=verse` + `ref=N` → write `[verse:N|caption]`
- `kind=commentary` / `prose_chapter` / `letter` → quote inline as a
  markdown blockquote (see below — they have no `ref`).

Worked example. Suppose two notes arrived:
  Note 1 · kind=lecture · ref=8209 · label=Утренняя прогулка, 1976-04-03, Бомбей
  Note 2 · kind=lecture · ref=7492 · label=Утренняя прогулка, 1975-01-02, Бомбей
Then your reply MUST include both `[card:8209]` and `[card:7492]`
markers (or `[cite:N|caption]` inline if you quote a fragment) —
NOT just a prose paragraph describing the lectures.

For commentary / letter / prose_chapter results (ref is null) — quote
inline as a markdown blockquote with attribution beneath:

> The cited text…
>
> — Source attribution from meta (e.g. "BG 2.13, purport")

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
    assistant messages' chip markers get folded back to `[cite:N|...]`
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

    async for chunk in llm.stream_completion(
        messages,
        model=model,
        temperature=temperature,
    ):
        text = chunk.get("text")
        if not text:
            continue
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
        "synth_done",
        request_id=request_id,
        prose_chars=prose_chars,
        notes_count=len(tool_results),
    )
    yield SynthesizerEvent(type="done", data={"prose": full_text})
