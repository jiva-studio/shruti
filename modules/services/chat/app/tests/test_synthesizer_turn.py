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
            lang="ru",
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
async def test_cite_marker_expanded_into_track_form() -> None:
    """LLM writes `[cite:N|caption]` — MarkerExpander unfolds N into
    the real track_id@start-end. Client gets the expanded form."""
    aliases = TurnAliasMap()
    n = aliases.alias_chunk("track_OkPVGYhR5PPu", 1500, 2500)
    expander = MarkerExpander(aliases)

    llm = StreamingLLM(
        chunks=[
            "Прабхупада объясняет это в ",
            f"[cite:{n}|01:30-02:30]",
            ".",
        ]
    )
    events = await _drain(
        run_synthesizer_turn(
            "?",
            tool_results=[{"placeholder": True}],
            lang="ru",
            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    full = "".join(ev.data["text"] for ev in events if ev.type == "delta")
    assert "[cite:track_OkPVGYhR5PPu@1500-2500|01:30-02:30]" in full
    # Integer form never reaches the client.
    assert f"[cite:{n}|" not in full


@pytest.mark.asyncio
async def test_verse_marker_expanded() -> None:
    """`[verse:N|caption]` → `[verse:source_id/tokens|caption]`."""
    aliases = TurnAliasMap()
    n = aliases.alias_verse("source_BG", "2.13", addr_label="BG 2.13")
    expander = MarkerExpander(aliases)

    llm = StreamingLLM(chunks=[f"См. [verse:{n}|БГ 2.13]"])
    events = await _drain(
        run_synthesizer_turn(
            "verse",
            tool_results=[{"placeholder": True}],
            lang="ru",
            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    full = "".join(ev.data["text"] for ev in events if ev.type == "delta")
    assert "[verse:source_BG/2.13|БГ 2.13]" in full
    assert f"[verse:{n}|" not in full


@pytest.mark.asyncio
async def test_marker_split_across_chunks_buffers_correctly() -> None:
    """LLM tokeniser might split `[cite:N|caption]` across multiple
    streaming chunks. MarkerExpander must buffer and emit the expanded
    form once the `]` closes."""
    aliases = TurnAliasMap()
    n = aliases.alias_chunk("track_X", 1000, 2000)
    expander = MarkerExpander(aliases)

    # Split into many tiny chunks so the marker straddles them.
    raw = f"Цитата [cite:{n}|caption] здесь"
    llm = StreamingLLM(chunks=[c for c in raw])

    events = await _drain(
        run_synthesizer_turn(
            "?",
            tool_results=[{"x": 1}],
            lang="ru",
            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    full = "".join(ev.data["text"] for ev in events if ev.type == "delta")
    assert "[cite:track_X@1000-2000|caption]" in full
    # `Цитата ` and ` здесь` made it through.
    assert "Цитата " in full
    assert " здесь" in full


@pytest.mark.asyncio
async def test_unknown_integer_ref_dropped() -> None:
    """LLM hallucinates an integer ref not in the alias map →
    MarkerExpander drops it silently (logs a `chat_marker_alias_miss`).
    Surrounding prose still streams."""
    aliases = TurnAliasMap()
    aliases.alias_chunk("track_X", 0, 100)
    expander = MarkerExpander(aliases)

    # 9999 is unlikely to be the minted ref (1-in-9999) — use a value
    # we know isn't allocated. Pre-mint a known ref + a clearly-fake one.
    bogus = 91337  # outside [1, 9999], explicitly invalid
    llm = StreamingLLM(chunks=[f"Хм [cite:{bogus}|fake] вот"])

    events = await _drain(
        run_synthesizer_turn(
            "?",
            tool_results=[{"x": 1}],
            lang="ru",
            llm=llm,
            expander=expander,
            system_prompt="sys",
        )
    )
    full = "".join(ev.data["text"] for ev in events if ev.type == "delta")
    # Bogus marker removed; surrounding text survives.
    assert "Хм  вот" in full or "Хм " in full and " вот" in full
    assert "cite:91337" not in full


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
            lang="ru",
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
            lang="ru",
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

    # Prior assistant content was folded down to user-visible text:
    # the caption survives, the integer ref + track id are gone.
    prior_assistant = msgs[2]["content"]
    assert "track_PRIOR" not in prior_assistant
    assert "[cite:" not in prior_assistant
    assert "prior" in prior_assistant

    # The latest user message (third in history) got the lang tag.
    latest_user = msgs[3]["content"]
    assert "lang=ru" in latest_user
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
            lang="en",
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
    assert "lang=en" in msgs[1]["content"]


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
            lang="ru",
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
    # the integer ref, label, and text.
    assert "7882" in out
    assert "BG 2.13" in out
    assert "absolute truth" in out


def test_format_tool_results_renders_marker_hint_without_cite_shape() -> None:
    """The note header tells the LLM `cite as cite-ref N` — NOT
    `[cite:N]`. If we wrote the literal marker in the header, weaker
    models copy it as-is into their reply, producing `[cite:N]` with
    no actual citation prose around it. Defensive pin."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results(
        [{"type": "lecture", "ref": 42, "label": "x", "text": "…", "meta": {}}]
    )
    # The integer is exposed; the bracket shape is not.
    assert "42" in out
    assert "[cite:42" not in out
    assert "[verse:" not in out


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
            lang="ru",
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


def test_format_tool_results_ref_is_top_level_field() -> None:
    """The note header must expose `ref=N` as a plain `key=value`
    pair, not buried in a phrase. The model latches onto the literal
    `ref=N` shape to copy into `[cite:N|caption]` / `[card:N]`. An
    earlier "cite as cite-ref N" phrasing was too oblique and the
    model dropped markers."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results(
        [{"type": "lecture", "ref": 8209, "label": "x", "meta": {}}]
    )
    assert "ref=8209" in out


def test_format_tool_results_track_uses_title_when_no_label() -> None:
    """tracks_list envelope has `title`, not `label`. The renderer
    must fall back to `title` so the synth header still carries a
    human label for the lecture — otherwise the model can't attribute
    the card."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results([
        {
            "type": "lecture",
            "ref": 8209,
            "title": "Вот вам ваше новое тело, сэр",
            "author_name": "Шрила Прабхупада",
            "location_name": "Лондон",
            "date": "1973-08-26",
            "duration_ms": 1680000,
        }
    ])
    assert "ref=8209" in out
    assert "label=Вот вам ваше новое тело, сэр" in out
    # tracks_list meta gets pulled into the per-note meta line.
    assert "author_name=Шрила Прабхупада" in out
    assert "location_name=Лондон" in out
    assert "date=1973-08-26" in out


def test_format_tool_results_flattens_list_results() -> None:
    """chunks_search returns `list[dict]`; propose_* returns a single
    `dict`. The renderer must accept both and flatten into one note
    list — earlier we crashed with `'list' object has no attribute
    'get'` when a chunks_search result landed in tool_results."""
    from shruti_chat.application.synthesizer_turn import _format_tool_results

    out = _format_tool_results(
        [
            # chunks_search shape: list of envelopes
            [
                {"type": "lecture", "ref": 1, "label": "L1", "meta": {}},
                {"type": "lecture", "ref": 2, "label": "L2", "meta": {}},
            ],
            # propose_* shape: single dict
            {"ok": True, "action_id": "abc123"},
            # error envelope: rendered as the error-line variant
            {"error": "no_match"},
        ]
    )
    # All three notes show up.
    assert "ref=1" in out
    assert "ref=2" in out
    assert "abc123" in out or "ok=True" in out or "Note 3" in out
    assert "no_match" in out
    # Renderer didn't crash on the heterogeneous list.
    assert out.count("Note ") >= 3


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
