"""Tests for `application/synthesizer_turn.py` — streaming + MarkerExpander.

Three concerns:

  1. Plain text streams through unchanged.
  2. Integer-ref markers `[cite:N]` / `[verse:N]` / etc. get expanded
     into their client-facing form by the in-flight `MarkerExpander`.
  3. Empty research notes → synth still streams (LLM presumably says
     "не нашёл", but that's a prompt concern; here we just verify
     plumbing doesn't crash on `[]`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator

import pytest

from shruti_chat.agent.marker_expander import MarkerExpander
from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.application.synthesizer_turn import (
    SynthesizerEvent,
    run_synthesizer_turn,
)
from shruti_chat.domain.entities import CompletionChunk, Message


@dataclass
class StreamingLLM:
    """Streams a fixed list of text chunks (one per .text chunk) then
    a finish_reason. Captures messages for assertion."""

    chunks: list[str] = field(default_factory=list)
    seen_messages: list[list[Message]] = field(default_factory=list)

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
    ) -> AsyncIterator[CompletionChunk]:
        self.seen_messages.append(messages)
        for piece in self.chunks:
            yield {"text": piece}
        yield {"finish_reason": "stop"}


async def _drain(gen: AsyncIterator[SynthesizerEvent]) -> list[SynthesizerEvent]:
    return [ev async for ev in gen]


@pytest.mark.asyncio
async def test_plain_text_passes_through() -> None:
    aliases = TurnAliasMap()
    expander = MarkerExpander(aliases)
    llm = StreamingLLM(chunks=["Привет, ", "это ", "ответ."])

    events = await _drain(
        run_synthesizer_turn(
            "что?",
            tool_results=[],

            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    deltas = [ev.data["text"] for ev in events if ev.type == "delta"]
    done = [ev for ev in events if ev.type == "done"]
    assert "".join(deltas) == "Привет, это ответ."
    assert len(done) == 1
    assert done[0].data["prose"] == "Привет, это ответ."


@pytest.mark.asyncio
async def test_ref_marker_to_lecture_expands_into_cite_form() -> None:
    """LLM writes `[^N]`; if alias N is a lecture fragment, server
    expands into the `[cite:track@start-end|caption]` shape the
    client renders. The caption comes from `aliases.captions`
    (populated by the background caption_generator). Period-after-
    marker gets swapped server-side."""
    aliases = TurnAliasMap()
    n = aliases.alias_chunk("track_OkPVGYhR5PPu", 1500, 2500)
    aliases.captions[n] = "01:30-02:30"
    expander = MarkerExpander(aliases)

    llm = StreamingLLM(
        chunks=[
            "Прабхупада объясняет это в ",
            f"[^{n}]",
            ".",
        ]
    )
    events = await _drain(
        run_synthesizer_turn(
            "?",
            tool_results=[{"placeholder": True}],

            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    full = "".join(ev.data["text"] for ev in events if ev.type == "delta")
    assert "[cite:track_OkPVGYhR5PPu@1500-2500|01:30-02:30]" in full
    # Period swapped to BEFORE the widget.
    assert full.rstrip().endswith("[cite:track_OkPVGYhR5PPu@1500-2500|01:30-02:30]")
    # Raw footnote form never reaches the client — always expanded.
    assert f"[^{n}" not in full


@pytest.mark.asyncio
async def test_ref_marker_to_verse_expands_into_verse_form() -> None:
    """`[^N]` resolving to a VerseRef → `[verse:source_id/tokens|addr_label]`.
    The verse caption is the alias's `addr_label`, not LLM-supplied."""
    aliases = TurnAliasMap()
    n = aliases.alias_verse("source_BG", "2.13", addr_label="БГ 2.13")
    expander = MarkerExpander(aliases)

    llm = StreamingLLM(chunks=[f"См. [^{n}]"])
    events = await _drain(
        run_synthesizer_turn(
            "verse",
            tool_results=[{"placeholder": True}],

            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    full = "".join(ev.data["text"] for ev in events if ev.type == "delta")
    assert "[verse:source_BG/2.13|БГ 2.13]" in full
    assert f"[^{n}" not in full


@pytest.mark.asyncio
async def test_ref_marker_split_across_chunks_buffers_correctly() -> None:
    """SSE deltas can split a marker mid-buffer. MarkerExpander must
    buffer and emit the expanded form once the `]` closes."""
    aliases = TurnAliasMap()
    n = aliases.alias_chunk("track_X", 1000, 2000)
    expander = MarkerExpander(aliases)

    raw = f"Цитата [^{n}] здесь"
    llm = StreamingLLM(chunks=[c for c in raw])

    events = await _drain(
        run_synthesizer_turn(
            "?",
            tool_results=[{"x": 1}],

            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    full = "".join(ev.data["text"] for ev in events if ev.type == "delta")
    assert "[cite:track_X@1000-2000]" in full
    assert "Цитата " in full
    assert " здесь" in full


@pytest.mark.asyncio
async def test_unknown_integer_ref_dropped() -> None:
    """LLM hallucinates an integer ref not in the alias map →
    MarkerExpander drops it silently (logs a `chat_marker_alias_miss`).
    Surrounding prose still streams; the dropped ref is never guessed
    back to one of the unused aliases."""
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_X", 0, 100)
    aliases.alias_chunk("track_Y", 0, 100)
    aliases.alias_chunk("track_Z", 0, 100)
    expander = MarkerExpander(aliases)

    # 91337 is way outside the sequential 1..K mint range, can't
    # collide with any minted alias.
    bogus = 91337
    llm = StreamingLLM(chunks=[f"Хм [^{bogus}] вот"])

    events = await _drain(
        run_synthesizer_turn(
            "?",
            tool_results=[{"x": 1}],

            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    full = "".join(ev.data["text"] for ev in events if ev.type == "delta")
    # Bogus marker removed; surrounding text survives with single space.
    assert "Хм вот" in full
    assert f"^{bogus}" not in full
    assert "cite:" not in full


@pytest.mark.asyncio
async def test_empty_tool_results_still_streams() -> None:
    """Empty research notes — synthesizer must still emit deltas
    (likely 'не нашёл'). We only verify plumbing here."""
    aliases = TurnAliasMap()
    expander = MarkerExpander(aliases)
    llm = StreamingLLM(chunks=["Не нашёл материалов на эту тему."])

    events = await _drain(
        run_synthesizer_turn(
            "найди про инопланетян",
            tool_results=[],

            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    deltas = [ev.data["text"] for ev in events if ev.type == "delta"]
    assert "Не нашёл" in "".join(deltas)


@pytest.mark.asyncio
async def test_history_flows_into_synth_messages() -> None:
    """Multi-turn: prior user/assistant turns appear in the LLM messages
    so synth can write coherent follow-up replies. Prior assistant
    chip markers get folded back to integer ref form via each turn's
    persisted aliases payload."""
    aliases = TurnAliasMap()
    n = aliases.alias_chunk("track_PRIOR", 100, 200)
    serialized = aliases.serialize()

    history = [
        {"role": "user", "content": "что Прабхупада говорил про карму?"},
        {
            "role": "assistant",
            "content": "Прабхупада объясняет [cite:track_PRIOR@100-200|prior]",
            "aliases": serialized,
        },
        {"role": "user", "content": "а ещё что?"},
    ]

    # Fresh expander/aliases for this turn — history aliases applied
    # only within fold_history.
    fresh_aliases = TurnAliasMap()
    expander = MarkerExpander(fresh_aliases)
    llm = StreamingLLM(chunks=["ответ."])

    await _drain(
        run_synthesizer_turn(
            "а ещё что?",
            tool_results=[],

            llm=llm,
            expander=expander,
            system_prompt="sys",
            history=history,
        )
    )

    # Inspect the messages the LLM saw.
    assert len(llm.seen_messages) == 1
    msgs = llm.seen_messages[0]
    roles = [m["role"] for m in msgs]
    # Shape: system (with grounding rules + research notes inlined),
    # then the 3-turn folded history. Notes ride inside system —
    # NOT as a separate assistant message — to keep Gemini Flash Lite
    # from echoing `[tool_use]`/`[tool_result]` blocks (see synth_turn).
    assert roles == ["system", "user", "assistant", "user"]

    # Prior assistant content was folded down to plain prose: ALL
    # widget markers stripped entirely (including their captions) so
    # the LLM in turn N+1 can't latch onto chip-format leftovers.
    prior_assistant = msgs[2]["content"]
    assert "track_PRIOR" not in prior_assistant
    assert "[cite:" not in prior_assistant
    assert "prior" not in prior_assistant   # caption dropped, not kept
    assert "Прабхупада объясняет" in prior_assistant

    # The latest user message (third in history) carries the current query.
    latest_user = msgs[3]["content"]
    assert "а ещё что?" in latest_user

    # No-history fallback path stays intact (covered elsewhere).


@pytest.mark.asyncio
async def test_no_history_uses_user_query_directly() -> None:
    """Backward-compat path: when history is None / empty, synth just
    builds [system, user_query, assistant-notes, now-answer]."""
    aliases = TurnAliasMap()
    expander = MarkerExpander(aliases)
    llm = StreamingLLM(chunks=["hi"])

    await _drain(
        run_synthesizer_turn(
            "single-turn query",
            tool_results=[],
            llm=llm,
            expander=expander,
            system_prompt="sys",
            history=None,
        )
    )
    msgs = llm.seen_messages[0]
    roles = [m["role"] for m in msgs]
    # Shape: system (grounding + notes), user (with query). Notes live
    # inside the system block per the synth refactor.
    assert roles == ["system", "user"]
    assert "single-turn query" in msgs[1]["content"]


@pytest.mark.asyncio
async def test_done_event_carries_full_prose() -> None:
    """The final `done` event includes the LLM's full prose (pre-expansion)
    for the bypass-marker audit downstream."""
    aliases = TurnAliasMap()
    n = aliases.alias_chunk("track_X", 0, 100)
    expander = MarkerExpander(aliases)
    llm = StreamingLLM(chunks=[f"hello [cite:{n}|y] world"])

    events = await _drain(
        run_synthesizer_turn(
            "?",
            tool_results=[{"x": 1}],

            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    done = [ev for ev in events if ev.type == "done"]
    assert len(done) == 1
    # Audit-side sees the un-expanded form (what the LLM literally wrote).
    assert done[0].data["prose"] == f"hello [cite:{n}|y] world"


# ─── Regression: tool-protocol leak prevention ──────────────────────
#
# Production bug: Gemini Flash Lite, when fed research notes formatted
# as `[result N]\n{json...}`, would copy that shape and emit literal
# `[tool_use] chunks_search(...)` / `[tool_result] [...]` blocks at
# the start of the user-visible answer (see commit history). The fix:
# render notes as prose paragraphs with no JSON envelopes and no
# bracketed result headers. These tests pin the prompt shape so the
# leak can't regress silently.


def test_format_tool_results_emits_no_trigger_tokens() -> None:
    """The rendered notes block must not contain the shapes that
    cue weaker LLMs into mimicking a tool-use transcript:
    `[result `, `[tool_`, raw JSON braces with quoted keys."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    notes = [
        {
            "type": "lecture",
            "ref": 7882,
            "label": "Lecture [27:50–28:45]",
            "text": "Our life is meant to understand absolute truth…",
            "lang": "ru",
            "meta": {"start_ms": 1670080, "end_ms": 1725600},
            "score": 0.54,
        },
        {
            "type": "verse",
            "ref": 482,
            "label": "BG 2.13",
            "text": "As the embodied soul…",
            "lang": "en",
            "meta": {"source_id": "BG", "tokens": "2.13"},
        },
        {"error": "no_match"},
    ]
    out = _format_tool_results(notes)

    forbidden = ("[result ", "[tool_use", "[tool_result", '"type":', '"ref":', '"text":')
    for needle in forbidden:
        assert needle not in out, (
            f"trigger token {needle!r} leaked into formatted notes — would re-introduce "
            f"the Gemini tool-use mimicry bug. Output was:\n{out}"
        )

    # Sanity: the model still has enough context to cite — it needs
    # the integer ref (lecture title kept; verse-ref label dropped to
    # break the `[^N] БГ X.Y` adjacency) and the text.
    assert "7882" in out
    # Verse-ref note has NO addr_label adjacency to the marker — the
    # widget will render the address on the client.
    assert "BG 2.13" not in out
    assert "absolute truth" in out


def test_format_tool_results_renders_footnote_marker_only() -> None:
    """The note header carries `[^N]` and nothing else with bracket
    syntax. The LLM copies the footnote shape verbatim into prose;
    `[cite:` / `[verse:` are server-side expansion outputs, NOT
    things the LLM should ever see in its input."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results(
        [{"type": "lecture", "ref": 42, "label": "x", "text": "…", "meta": {}}]
    )
    assert "[^42]" in out
    assert "[cite:42" not in out
    assert "[verse:" not in out
    assert "[ref:" not in out


@pytest.mark.asyncio
async def test_notes_in_system_block_not_assistant_role() -> None:
    """Notes ride INSIDE the system prompt — never as an `assistant`
    message. The `assistant`-role envelope caused Gemini Flash Lite to
    treat the notes as the opening of its own turn and continue with
    a tool-use trace. Pin this invariant so a future refactor can't
    silently regress."""
    aliases = TurnAliasMap()
    expander = MarkerExpander(aliases)
    llm = StreamingLLM(chunks=["ok"])

    await _drain(
        run_synthesizer_turn(
            "q",
            tool_results=[
                {"type": "lecture", "ref": 1, "label": "L", "text": "Body…", "meta": {}}
            ],

            llm=llm,
            expander=expander,
            system_prompt="SYS",
            history=None,
        )
    )
    msgs = llm.seen_messages[0]
    # System block carries the note body…
    assert msgs[0]["role"] == "system"
    assert "Body…" in msgs[0]["content"]
    # …and no other message echoes it.
    for m in msgs[1:]:
        assert "Body…" not in m["content"], (
            f"note text leaked into non-system message {m['role']!r}"
        )
    # Notes must NOT use the `[result N]` header that mimics Anthropic
    # tool-result envelopes. The HARD RULE in the system prompt is
    # allowed to NAME `[tool_use]` / `[tool_result]` as forbidden
    # patterns — the model treats those as negative examples, not a
    # template to copy.
    for m in msgs:
        assert "[result " not in m["content"]


# ─── Regressions for tracks_list note rendering ─────────────────────
#
# Production bug: "Покажи лекции по БГ 2.13" routed correctly to
# find_track → catalog_worker → tracks_list, which returned 5 lectures
# at the alias map, but the synth wrote "Не нашёл лекций" because the
# note headers read `kind=result · ref=N` (tracks_list shape has no
# `type` field). The grounding instruction binds `[card:N]` emission
# to `kind=lecture`, so the model had no rule that fired. These tests
# pin the fix.


def test_format_tool_results_action_renders_copy_marker_directive() -> None:
    """Action-tool results (`{ok, kind, action_id, ...}`) render as an
    explicit "copy this marker" directive — synth just copies the
    `[action:kind|id=ID]` string character-for-character. Prevents the
    "Карточка действия повреждена" failure mode where synth either
    skipped the marker or invented the action_id."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results([{
        "ok": True,
        "kind": "share_pdf",
        "action_id": "ab12cd34",
        "items": [{"track_id": "track_X", "pdf_url": "https://…/a.pdf"}],
    }])
    assert "ACTION CARD READY" in out
    assert "[action:share_pdf|id=ab12cd34]" in out


def test_format_tool_results_action_unknown_kind_treated_as_regular_note() -> None:
    """Defensive: a result with `action_id` but a `kind` we don't
    recognise (rogue tool / future kind) falls through to the regular
    note renderer instead of emitting a bogus marker."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results([{
        "ok": True,
        "kind": "unknown_future_action",
        "action_id": "ab12cd34",
    }])
    assert "ACTION CARD READY" not in out
    assert "[action:unknown_future_action" not in out


def test_format_tool_results_action_for_each_known_kind() -> None:
    """All four action kinds emit the directive correctly."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    for kind in (
        "share_pdf",
        "enable_daily_reminder",
        "configure_smart_library",
        "upgrade_to_pro",
    ):
        out = _format_tool_results([{
            "ok": True,
            "kind": kind,
            "action_id": "xx0011aa",
        }])
        assert f"[action:{kind}|id=xx0011aa]" in out, f"missing for kind={kind}"


def test_format_tool_results_ref_emitted_as_literal_marker() -> None:
    """The note header leads with the LITERAL `[^N]` marker — the
    model copies it verbatim into prose to cite. Lecture/title pair
    survives adjacency because the title is natural-language and
    won't be mistaken for a shloka address."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results(
        [{"type": "lecture", "ref": 5, "label": "x", "meta": {}}]
    )
    assert "[^5]" in out
    assert "Note 1" not in out


def test_format_tool_results_verse_ref_has_no_addr_label_adjacency() -> None:
    """Verse-with-ref header drops `addr_label` so the LLM never sees
    a shloka address adjacent to `[^N]` — the strongest priming
    source for `[^БГ 2.13]` string-stuffed hallucinations. The verse
    widget on the client renders the address."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results([{
        "type": "verse",
        "ref": 3,
        "label": "БГ 2.13",
        "text": "Душа меняет тела…",
        "meta": {"source_id": "source_BG", "tokens": "2.13"},
    }])
    assert "[^3]" in out
    assert "БГ 2.13" not in out
    assert "Душа меняет тела" in out


def test_format_tool_results_track_uses_title_when_no_label() -> None:
    """tracks_list envelope has `title`, not `label`. The renderer
    must fall back to `title` so the header still carries the
    human attribution — otherwise the LLM can't name the lecture.
    Title is natural-language and stays adjacent to the marker."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results([
        {
            "type": "lecture",
            "ref": 8,
            "title": "Вот вам ваше новое тело, сэр",
            "author_name": "Шрила Прабхупада",
            "location_name": "Лондон",
            "date": "1973-08-26",
            "duration_ms": 1680000,
        }
    ])
    assert "[^8]" in out
    assert "Вот вам ваше новое тело, сэр" in out
    # Technical fields (author_name=, date=, location_name=) are
    # intentionally NOT in the LLM-facing render — noise that doesn't
    # change LLM behaviour and confuses smaller models.
    assert "author_name=" not in out
    assert "location_name=" not in out


def test_format_tool_results_commentary_keeps_addr_label() -> None:
    """Commentary / letter / prose_chapter notes have no `ref` —
    they're quoted as markdown blockquotes. The header MUST keep the
    addr_label so the LLM can write a proper attribution line
    (e.g. `*(комментарий к БГ 2.13)*`)."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results([{
        "type": "commentary",
        "ref": None,
        "label": "БГ 2.13, комментарий",
        "text": "Каждое живое существо…",
        "meta": {"source_id": "source_BG", "tokens": "2.13"},
    }])
    assert "БГ 2.13, комментарий" in out
    assert "[^" not in out


def test_format_tool_results_flattens_list_results() -> None:
    """chunks_search returns `list[dict]`; propose_* returns a single
    `dict`. The renderer accepts both and flattens into one note
    list."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results(
        [
            [
                {"type": "lecture", "ref": 1, "label": "L1", "meta": {}},
                {"type": "lecture", "ref": 2, "label": "L2", "meta": {}},
            ],
            {"ok": True, "action_id": "abc123"},
            {"error": "no_match"},
        ]
    )
    assert "[^1]" in out
    assert "[^2]" in out
    assert "no_match" in out
    assert out.count("\n\n") >= 2


def test_aliased_tracks_list_results_tagged_kind_lecture() -> None:
    """tracks_list envelope has no `type` field on the raw shape; the
    aliased wrapper MUST tag it as `type="lecture"` so the synth
    grounding instruction can fire its `kind=lecture + ref=N → [card:N]`
    rule. Production bug: without this tag, synth refused with
    "Не нашёл лекций" even when 5 tracks were in the alias map.
    """
    from shruti_chat.agent.aliased_tools import build_aliased_tools

    raw_rows = [
        {
            "track_id": "track_ABC",
            "title": "Вот вам ваше новое тело, сэр",
            "lang": "ru",
            "author_name": "Прабхупада",
        }
    ]

    async def fake_tracks_list(**_: object) -> list[dict[str, object]]:
        return raw_rows

    aliases = TurnAliasMap()
    wrapped = build_aliased_tools({"tracks_list": fake_tracks_list}, aliases)

    async def _run() -> list[dict[str, object]]:
        return await wrapped["tracks_list"]()

    import asyncio

    out = asyncio.run(_run())
    assert isinstance(out, list) and len(out) == 1
    row = out[0]
    assert row.get("type") == "lecture", (
        "tracks_list rows must be tagged kind=lecture by the alias wrapper "
        "so the synth knows to emit [card:N] for them — see "
        "agent/aliased_tools._alias_track_entry"
    )
    # And the track id was stripped + replaced with an integer ref.
    assert "track_id" not in row
    assert isinstance(row.get("ref"), int)
