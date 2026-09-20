"""Tests for the multilingual citation path (PR2):

- `localize_citation`'s three branches (native / translate / en-preferred)
- the new additive MT wire fields on the flush payloads
- `clamp_retrieval_lang` (answer-lang ≠ retrieval-lang split)
- the request DTO accepting an arbitrary lang + translate_citations
"""

from __future__ import annotations

import pytest

import lectorium_chat.agent.graph.nodes._worker_common as wc  # noqa: F401
from lectorium_chat.agent import cards as _cards
from lectorium_chat.agent.graph.nodes._worker_common import (
    build_verse_payload,
    flush_card_payloads,
    localize_citation,
)
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.research.pipeline import clamp_retrieval_lang


class FakeTranslator:
    """Records calls; returns a deterministic '<lang>:<text>' string."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def translate(self, text, *, src_lang, tgt_lang):
        self.calls.append({"text": text, "src_lang": src_lang, "tgt_lang": tgt_lang})
        return f"[{tgt_lang}] {text}"


@pytest.fixture
def capture_writer(monkeypatch):
    events: list[dict] = []
    monkeypatch.setattr(_cards, "get_stream_writer", lambda: events.append)
    return events


# ── localize_citation — three branches ───────────────────────────────────


async def test_localize_native_variant_wins():
    ctx = TurnContext(lang_code="ru", translate_citations=True, translator=FakeTranslator())
    shown, original, mt = await localize_citation(
        ctx, variants={"ru": "родной", "en": "native"},
        source_text="native", src_lang="en",
    )
    assert (shown, original, mt) == ("родной", None, False)
    # No translation call when a native variant exists.
    assert ctx.translator.calls == []


async def test_localize_translates_when_opted_in():
    tr = FakeTranslator()
    ctx = TurnContext(lang_code="uk", translate_citations=True, translator=tr)
    shown, original, mt = await localize_citation(
        ctx, variants={"en": "the source"}, source_text="the source", src_lang="en",
    )
    assert mt is True
    assert original == "the source"
    assert shown == "[uk] the source"
    assert tr.calls == [{"text": "the source", "src_lang": "en", "tgt_lang": "uk"}]


async def test_localize_en_preferred_when_flag_off():
    ctx = TurnContext(lang_code="uk", translate_citations=False, translator=FakeTranslator())
    shown, original, mt = await localize_citation(
        ctx, variants={"en": "english fallback"},
        source_text="the source", src_lang="en",
    )
    assert (shown, original, mt) == ("english fallback", None, False)
    assert ctx.translator.calls == []


async def test_localize_en_preferred_no_en_uses_source():
    ctx = TurnContext(lang_code="uk", translate_citations=False, translator=None)
    shown, original, mt = await localize_citation(
        ctx, variants={}, source_text="raw source", src_lang="ru",
    )
    assert (shown, original, mt) == ("raw source", None, False)


async def test_localize_same_language_noop_not_marked_mt():
    class NoopTranslator:
        async def translate(self, text, *, src_lang, tgt_lang):
            return text  # unchanged

    ctx = TurnContext(lang_code="sr-Latn", translate_citations=True, translator=NoopTranslator())
    shown, original, mt = await localize_citation(
        ctx, variants={"en": "x"}, source_text="x", src_lang="en",
    )
    # Unchanged text → not flagged MT, no original carried.
    assert mt is False
    assert original is None


# ── cite_transcript flush wire fields ────────────────────────────────────


async def test_flush_cite_translates_non_native(capture_writer):
    tr = FakeTranslator()
    ctx = TurnContext(lang_code="uk", translate_citations=True, translator=tr)
    n = ctx.aliases.alias_chunk("t1", 1000, 2000, lang="en")
    ctx.aliases.chunk_texts[n] = "english transcript"

    await flush_card_payloads(ctx)

    payload = capture_writer[0]["data"]["payload"]
    assert payload["mt"] is True
    assert payload["text"] == "[uk] english transcript"
    assert payload["text_original"] == "english transcript"


async def test_flush_cite_skipped_for_card_client(capture_writer):
    """Card-capable clients emit cite cards lazily at synth time, so the eager
    flush must NOT translate or emit the aliased lecture-fragment pool."""
    tr = FakeTranslator()
    ctx = TurnContext(
        lang_code="uk", translate_citations=True, translator=tr,
        capabilities={"commentary_card": True},
    )
    n = ctx.aliases.alias_chunk("t1", 1000, 2000, lang="en")
    ctx.aliases.chunk_texts[n] = "english transcript"
    await flush_card_payloads(ctx)
    assert capture_writer == []  # nothing emitted
    assert tr.calls == []        # nothing translated


async def test_flush_cite_native_no_mt_field(capture_writer):
    ctx = TurnContext(lang_code="en", translate_citations=True, translator=FakeTranslator())
    n = ctx.aliases.alias_chunk("t1", 1000, 2000, lang="en")
    ctx.aliases.chunk_texts[n] = "english transcript"

    await flush_card_payloads(ctx)

    payload = capture_writer[0]["data"]["payload"]
    assert "mt" not in payload
    assert "text_original" not in payload
    assert payload["text"] == "english transcript"


async def test_a_transcript_quote_is_translated_without_being_asked(capture_writer):
    """Spoken words are not scripture.

    The opt-in exists to protect the WORDING of verses and purports. A transcript
    has no such claim, and someone's own uploads are usually in another language
    than their question — production showed a Russian answer quoting English
    fragments of the very teacher that was asked for, unreadable to the person who
    asked. So a non-native transcript fragment is translated regardless of the
    flag, with the original alongside it.
    """
    tr = FakeTranslator()
    ctx = TurnContext(lang_code="uk", translate_citations=False, translator=tr)
    n = ctx.aliases.alias_chunk("t1", 1000, 2000, lang="en")
    ctx.aliases.chunk_texts[n] = "english transcript"

    await flush_card_payloads(ctx)

    payload = capture_writer[0]["data"]["payload"]
    assert payload["mt"] is True
    assert payload["text_original"] == "english transcript"
    assert tr.calls, "the translator must be used"


async def test_scripture_still_waits_to_be_asked() -> None:
    """The other half of the rule: a verse translation is NOT machine-translated
    on a whim — with the flag off it falls back to the English variant."""
    tr = FakeTranslator()
    ctx = TurnContext(lang_code="uk", translate_citations=False, translator=tr)
    shown, original, mt = await localize_citation(
        ctx,
        variants={"en": "english translation"},
        source_text="english translation",
        src_lang="en",
    )
    assert shown == "english translation"
    assert mt is False and original is None
    assert tr.calls == []


# ── verse flush wire fields ──────────────────────────────────────────────


def _fake_verse_body(translation):
    return {
        "sanskrit": "kṛṣṇa",
        "transliteration": {"en": "kṛṣṇa", "uk": "крішна"},
        "translation": dict(translation),
        "audio_path": "",
    }


class _StubLibraryRepo:
    """`LibraryRepository` double serving one canned verse body."""

    def __init__(self, translation) -> None:
        self._body = _fake_verse_body(translation)

    async def fetch_verse_body(self, source_id, tokens):
        return self._body


async def test_flush_verse_translates_into_lang(capture_writer):
    tr = FakeTranslator()
    ctx = TurnContext(
        lang_code="uk", translate_citations=True, translator=tr,
        library_repo=_StubLibraryRepo({"en": "english verse"}),
    )
    ctx.aliases.alias_verse("BG", "2.13", addr_label="BG 2.13")

    await flush_card_payloads(ctx)

    payload = capture_writer[0]["data"]["payload"]
    assert payload["mt"] is True
    assert payload["translation_original_lang"] == "en"
    assert payload["translation"]["uk"] == "[uk] english verse"
    # Original english variant preserved in the map (client reads it as origin).
    assert payload["translation"]["en"] == "english verse"


async def test_flush_verse_native_no_mt(capture_writer):
    ctx = TurnContext(
        lang_code="uk", translate_citations=True, translator=FakeTranslator(),
        library_repo=_StubLibraryRepo({"en": "english verse", "uk": "український вірш"}),
    )
    ctx.aliases.alias_verse("BG", "2.13", addr_label="BG 2.13")

    await flush_card_payloads(ctx)

    payload = capture_writer[0]["data"]["payload"]
    assert "mt" not in payload
    assert payload["translation"]["uk"] == "український вірш"


async def test_flush_verse_skipped_for_card_client(capture_writer):
    """Card-capable clients emit verse cards lazily at synth time, so the
    eager flush must NOT translate or emit the aliased verse pool."""
    tr = FakeTranslator()
    ctx = TurnContext(
        lang_code="uk", translate_citations=True, translator=tr,
        library_repo=_StubLibraryRepo({"en": "english verse"}),
        capabilities={"commentary_card": True},
    )
    ctx.aliases.alias_verse("BG", "2.13", addr_label="BG 2.13")

    await flush_card_payloads(ctx)
    assert capture_writer == []   # nothing emitted
    assert tr.calls == []         # nothing translated


async def test_build_verse_payload_translates_cited():
    """The extracted builder still fetches + translates one verse (used by
    the lazy synth-time emit, so translation runs only for cited verses)."""
    tr = FakeTranslator()
    ctx = TurnContext(
        lang_code="uk", translate_citations=True, translator=tr,
        library_repo=_StubLibraryRepo({"en": "english verse"}),
    )
    ctx.aliases.alias_verse("BG", "2.13", addr_label="BG 2.13")
    _, vref = ctx.aliases.verse_refs()[0]

    payload = await build_verse_payload(ctx, vref)
    assert payload is not None
    assert payload["mt"] is True
    assert payload["translation"]["uk"] == "[uk] english verse"
    assert payload["translation"]["en"] == "english verse"


async def test_build_verse_payload_ships_answer_lang_only():
    """The card shows the ANSWER language, which the router settles into
    `ctx.lang_code` — not the client's locale. The payload names it and carries only
    that translation, so a client on a different locale can't render another."""
    ctx = TurnContext(
        lang_code="ru",
        library_repo=_StubLibraryRepo({"en": "english verse", "ru": "русский стих"}),
    )
    ctx.aliases.alias_verse("BG", "2.13", addr_label="BG 2.13")
    _, vref = ctx.aliases.verse_refs()[0]

    payload = await build_verse_payload(ctx, vref)
    assert payload["lang"] == "ru"
    assert payload["translation"] == {"ru": "русский стих"}


async def test_build_verse_payload_lang_falls_back_to_available():
    """No variant in the answer language and no MT → the card shows en, and
    `lang` says so rather than naming a translation the payload lacks."""
    ctx = TurnContext(lang_code="uk", library_repo=_StubLibraryRepo({"en": "english verse"}))
    ctx.aliases.alias_verse("BG", "2.13", addr_label="BG 2.13")
    _, vref = ctx.aliases.verse_refs()[0]

    payload = await build_verse_payload(ctx, vref)
    assert payload["lang"] == "en"
    assert payload["translation"] == {"en": "english verse"}


async def test_build_verse_payload_mt_keeps_original():
    """A machine-translated verse also ships `en` — the card's "view original"
    toggle reads it."""
    ctx = TurnContext(
        lang_code="uk", translate_citations=True, translator=FakeTranslator(),
        library_repo=_StubLibraryRepo({"en": "english verse"}),
    )
    ctx.aliases.alias_verse("BG", "2.13", addr_label="BG 2.13")
    _, vref = ctx.aliases.verse_refs()[0]

    payload = await build_verse_payload(ctx, vref)
    assert payload["lang"] == "uk"
    assert payload["translation"] == {"uk": "[uk] english verse", "en": "english verse"}


# ── retrieval-lang derivation ────────────────────────────────────────────


def test_clamp_retrieval_lang_in_corpus_passes_through():
    assert clamp_retrieval_lang("ru", ["ru", "en"]) == "ru"
    assert clamp_retrieval_lang("en", ["ru", "en"]) == "en"


def test_clamp_retrieval_lang_east_slavic_reduces_to_ru():
    assert clamp_retrieval_lang("uk", ["ru", "en"]) == "ru"
    assert clamp_retrieval_lang("uk_UA", ["ru", "en"]) == "ru"


def test_clamp_retrieval_lang_non_corpus_falls_to_en():
    assert clamp_retrieval_lang("sr-Cyrl", ["ru", "en"]) == "en"
    assert clamp_retrieval_lang("uk", ["en"]) == "en"


def test_clamp_retrieval_lang_empty_corpus_falls_to_en():
    assert clamp_retrieval_lang("ru", []) == "en"


# ── request DTO accepts arbitrary lang + translate_citations ──────────────


def test_request_dto_accepts_arbitrary_lang_and_flag():
    from lectorium_chat.api.schemas.chat import ChatRequestDto

    dto = ChatRequestDto(
        messages=[{"role": "user", "content": "hi"}],
        lang="sr-Cyrl",
        translate_citations=True,
    )
    assert dto.lang == "sr-Cyrl"
    assert dto.translate_citations is True


def test_request_dto_defaults():
    from lectorium_chat.api.schemas.chat import ChatRequestDto

    dto = ChatRequestDto(messages=[{"role": "user", "content": "hi"}])
    assert dto.lang == "en"
    assert dto.translate_citations is False


# ── inline commentary pre-translation ────────────────────────────────────


async def test_translate_commentaries_fills_aligned_sentences():
    from lectorium_chat.agent.graph.nodes._worker_common import translate_commentaries

    class JoinTranslator:
        async def translate(self, text, *, src_lang, tgt_lang):
            # Prefix each line so the count is preserved (newline-aligned).
            return "\n".join(f"<{tgt_lang}>{ln}" for ln in text.split("\n"))

    ctx = TurnContext(lang_code="uk", translate_citations=True, translator=JoinTranslator())
    n = ctx.aliases.alias_commentary(
        "doc1", 0, addr_label="BG 2.13", author_name="Prabhupada",
        sentences=["First sentence.", "Second sentence."],
    )

    await translate_commentaries(ctx)

    ref = ctx.aliases.resolve(n)
    assert ref.mt is True
    assert ref.sentences_translated == ("<uk>First sentence.", "<uk>Second sentence.")
    # marker_expander renders the translated sentences when present.
    from lectorium_chat.agent.marker_expander import MarkerExpander

    exp = MarkerExpander(ctx.aliases)
    out = await exp.feed(f"see [^{n}|s=0]")
    out += await exp.flush()
    assert "<uk>First sentence." in out


async def test_translate_commentaries_noop_when_flag_off():
    from lectorium_chat.agent.graph.nodes._worker_common import translate_commentaries

    class Boom:
        async def translate(self, *a, **k):
            raise AssertionError("must not be called")

    ctx = TurnContext(lang_code="uk", translate_citations=False, translator=Boom())
    n = ctx.aliases.alias_commentary(
        "doc1", 0, addr_label="BG 2.13", author_name="P",
        sentences=["a.", "b."],
    )
    await translate_commentaries(ctx)
    ref = ctx.aliases.resolve(n)
    assert ref.sentences_translated is None
    assert ref.mt is False
