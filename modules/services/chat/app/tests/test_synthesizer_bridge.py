"""Tests for `synthesizer._bridge_synth_events` — the producer/consumer that
overlaps citation translation with generation. Asserts the output ORDER
(card action before its marker delta) and that the lazy translation / verse
build still happen correctly through the concurrent path."""

from __future__ import annotations

import lectorium_chat.agent.graph.nodes._worker_common as wc
from lectorium_chat.agent.graph.nodes.synthesizer import _bridge_synth_events
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.application.synthesizer_turn import SynthesizerEvent


class _Tr:
    def __init__(self) -> None:
        self.calls = 0

    async def translate(self, text, *, src_lang, tgt_lang):
        self.calls += 1
        return f"[{tgt_lang}] {text}"


async def _events(*evs):
    for e in evs:
        yield e


def _comment_action(ref: int, text: str) -> SynthesizerEvent:
    return SynthesizerEvent(
        type="action",
        data={
            "kind": "commentary",
            "id": f"commentary_{ref}",
            "payload": {"ref": ref, "text": text, "author_name": "A", "addr_label": "BG 2.13"},
        },
    )


def _fake_verse_body(translation: dict[str, str]) -> dict:
    return {
        "sanskrit": "मात्रा",
        "transliteration": {"en": "mātrā"},
        "translation": translation,
        "audio_path": None,
    }


async def test_bridge_translates_and_preserves_order():
    tr = _Tr()
    ctx = TurnContext(
        lang="sr-Cyrl", retrieval_lang="en", translate_citations=True, translator=tr
    )
    out: list[dict] = []
    events = _events(
        SynthesizerEvent(type="delta", data={"text": "Before "}),
        _comment_action(7, "The soul is eternal."),
        SynthesizerEvent(type="delta", data={"text": "[commentary:7] after."}),
        SynthesizerEvent(type="done", data={}),
    )
    await _bridge_synth_events(events, ctx, out.append)

    kinds = [(e["type"], e["data"].get("kind")) for e in out]
    # action(commentary) must come BEFORE the delta carrying its marker.
    assert kinds == [("delta", None), ("action", "commentary"), ("delta", None)]
    payload = out[1]["data"]["payload"]
    assert payload["mt"] is True
    assert payload["text"] == "[sr-Cyrl] The soul is eternal."
    assert payload["text_original"] == "The soul is eternal."
    assert tr.calls == 1


async def test_bridge_builds_verse_card(monkeypatch):
    tr = _Tr()
    ctx = TurnContext(
        lang="sr-Cyrl", retrieval_lang="en", translate_citations=True, translator=tr,
        library_db_path="/fake/library.db",
    )
    am = TurnAliasMap()
    am.alias_verse("BG", "2.13", addr_label="BG 2.13")
    _, vref = am.verse_refs()[0]

    async def fake_fetch(db, source_id, tokens):
        return _fake_verse_body({"en": "english verse"})

    monkeypatch.setattr(wc, "fetch_verse_body", fake_fetch)
    out: list[dict] = []
    events = _events(
        SynthesizerEvent(type="verse_request", data={"vref": vref}),
        SynthesizerEvent(type="delta", data={"text": "[verse:BG/2.13|BG 2.13]"}),
    )
    await _bridge_synth_events(events, ctx, out.append)

    assert out[0]["data"]["kind"] == "verse"  # verse action before its delta
    assert out[1]["type"] == "delta"
    vp = out[0]["data"]["payload"]
    assert vp["translation"]["sr-Cyrl"] == "[sr-Cyrl] english verse"
    assert vp["mt"] is True


async def test_bridge_dedups_repeated_verse(monkeypatch):
    ctx = TurnContext(lang="ru", retrieval_lang="ru", translator=_Tr(), library_db_path="/x")
    am = TurnAliasMap()
    am.alias_verse("BG", "2.13", addr_label="BG 2.13")
    _, vref = am.verse_refs()[0]

    async def fake_fetch(db, source_id, tokens):
        return _fake_verse_body({"ru": "русский стих"})

    monkeypatch.setattr(wc, "fetch_verse_body", fake_fetch)
    out: list[dict] = []
    events = _events(
        SynthesizerEvent(type="verse_request", data={"vref": vref}),
        SynthesizerEvent(type="verse_request", data={"vref": vref}),  # cited twice
    )
    await _bridge_synth_events(events, ctx, out.append)
    verses = [e for e in out if e["data"].get("kind") == "verse"]
    assert len(verses) == 1  # deduped


async def test_bridge_native_answer_no_translation():
    tr = _Tr()
    ctx = TurnContext(lang="ru", retrieval_lang="ru", translate_citations=True, translator=tr)
    out: list[dict] = []
    events = _events(_comment_action(3, "русский текст"))
    await _bridge_synth_events(events, ctx, out.append)
    assert tr.calls == 0  # native: nothing translated
    assert "mt" not in out[0]["data"]["payload"]


async def test_bridge_builds_cite_card():
    tr = _Tr()
    am = TurnAliasMap()
    n = am.alias_chunk("track_X", 1000, 2000, lang="en")
    am.chunk_texts[n] = "The soul is eternal."
    _, cref = am.cite_refs()[0]
    ctx = TurnContext(lang="sr-Cyrl", translate_citations=True, translator=tr, aliases=am)
    out: list[dict] = []
    events = _events(
        SynthesizerEvent(type="cite_request", data={"ref_num": n, "cref": cref}),
        SynthesizerEvent(type="delta", data={"text": "[cite:track_X@1000-2000]"}),
    )
    await _bridge_synth_events(events, ctx, out.append)
    assert out[0]["data"]["kind"] == "cite_transcript"  # cite action before its delta
    assert out[1]["type"] == "delta"
    p = out[0]["data"]["payload"]
    assert p["mt"] is True
    assert p["text"] == "[sr-Cyrl] The soul is eternal."
    assert p["text_original"] == "The soul is eternal."
    assert tr.calls == 1


async def test_bridge_dedups_repeated_cite():
    am = TurnAliasMap()
    n = am.alias_chunk("track_X", 1000, 2000, lang="en")
    am.chunk_texts[n] = "verbatim"
    _, cref = am.cite_refs()[0]
    ctx = TurnContext(lang="en", translate_citations=True, translator=_Tr(), aliases=am)
    out: list[dict] = []
    events = _events(
        SynthesizerEvent(type="cite_request", data={"ref_num": n, "cref": cref}),
        SynthesizerEvent(type="cite_request", data={"ref_num": n, "cref": cref}),
    )
    await _bridge_synth_events(events, ctx, out.append)
    cites = [e for e in out if e["data"].get("kind") == "cite_transcript"]
    assert len(cites) == 1  # deduped
