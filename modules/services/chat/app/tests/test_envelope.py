"""Unit tests for chunk envelope builders."""

from __future__ import annotations

from lectorium_chat.agent.tools._envelope import (
    lecture_to_envelope,
    library_to_envelope,
)
from lectorium_chat.agent.turn_aliases import (
    MediaRef,
    TurnAliasMap,
    ChunkRef,
    VerseRef,
)
from lectorium_chat.domain.entities import Chunk, LibraryChunk


def test_lecture_to_envelope_strips_track_id() -> None:
    chunk = Chunk(
        track_id="track_OkPVGYhR5PPu",
        lang="ru",
        start_ms=12_000,
        end_ms=15_000,
        text="hello",
        reference_source_id=None,
    )
    aliases = TurnAliasMap()
    env = lecture_to_envelope(chunk, alias_map=aliases, score=0.87)

    assert env["type"] == "lecture"
    assert isinstance(env["ref"], int)
    assert "track_id" not in env
    assert "track_id" not in env["meta"]
    assert env["text"] == "hello"
    assert env["lang"] == "ru"
    assert env["score"] == 0.87
    assert env["meta"]["start_ms"] == 12_000
    assert env["meta"]["end_ms"] == 15_000

    # Ref resolves back to original track_id (the alias map owns the secret).
    # The fragment's transcript lang rides along so flush_cite_payloads can
    # re-fetch the snippet text with the right language filter.
    assert aliases.resolve(env["ref"]) == ChunkRef(
        "track_OkPVGYhR5PPu", 12_000, 15_000, lang="ru"
    )


def test_lecture_to_envelope_stashes_exact_chunk_text() -> None:
    # The mint point stashes the chunk's verbatim text so flush_cite_payloads
    # emits the snippet that corresponds 1:1 to this fragment's window —
    # never a wider, overlapping span re-derived from the DB later.
    chunk = Chunk(
        track_id="t1", lang="ru", start_ms=12_000, end_ms=15_000,
        text="exact fragment text", reference_source_id=None,
    )
    aliases = TurnAliasMap()
    env = lecture_to_envelope(chunk, alias_map=aliases)
    assert aliases.chunk_texts[env["ref"]] == "exact fragment text"


def test_lecture_to_envelope_includes_reference_source_id() -> None:
    chunk = Chunk(
        track_id="t1", lang="ru", start_ms=0, end_ms=1000,
        text="x", reference_source_id="BG",
    )
    env = lecture_to_envelope(chunk, alias_map=TurnAliasMap())
    assert env["meta"]["reference_source_id"] == "BG"


def test_lecture_to_envelope_label_is_empty() -> None:
    # The timecode label ("Lecture [12:00–12:45]") was intentionally
    # dropped — surfacing it in the LLM-facing header only primed the
    # model to copy timecodes into its prose. The timecode now lives in
    # `meta` and rides to the client via the alias map.
    chunk = Chunk(track_id="t1", lang="ru", start_ms=720_000, end_ms=765_000,
                  text="x", reference_source_id=None)
    env = lecture_to_envelope(chunk, alias_map=TurnAliasMap())
    assert env["label"] == ""


def test_lecture_to_envelope_score_none_for_exact_lookup() -> None:
    chunk = Chunk(track_id="t1", lang="ru", start_ms=0, end_ms=1000,
                  text="x", reference_source_id=None)
    env = lecture_to_envelope(chunk, alias_map=TurnAliasMap())
    assert env["score"] is None


def test_verse_envelope_keeps_source_id_and_tokens() -> None:
    chunk = LibraryChunk(
        item_id="verse_xyz",
        item_kind="verse",
        source_id="BG",
        tokens="2.13",
        author_id=None,
        doc_date=None,
        lang="ru",
        segment_index=0,
        text="dehino smin yatha dehe...",
        addr_label="БГ 2.13",
    )
    aliases = TurnAliasMap()
    env = library_to_envelope(chunk, alias_map=aliases, score=0.84)

    assert env["type"] == "verse"
    assert isinstance(env["ref"], int)
    assert env["label"] == "БГ 2.13"
    assert env["meta"]["source_id"] == "BG"
    assert env["meta"]["tokens"] == "2.13"
    assert env["score"] == 0.84
    # Ref resolves to VerseRef (drives [verse:source_id/tokens|...] markers)
    assert aliases.resolve(env["ref"]) == VerseRef("BG", "2.13", addr_label="БГ 2.13")


def test_commentary_envelope_mints_ref_with_sentences() -> None:
    chunk = LibraryChunk(
        item_id="comm_xyz",
        item_kind="commentary",
        source_id="BG",
        tokens="2.13",
        author_id="prabhupada",
        doc_date=None,
        lang="ru",
        segment_index=0,
        text="Первое предложение. Второе предложение. Третье предложение.",
        addr_label="БГ 2.13 (комментарий)",
    )
    aliases = TurnAliasMap()
    env = library_to_envelope(chunk, alias_map=aliases, score=0.7)

    assert env["type"] == "commentary"
    # Commentary now gets a ref so the LLM can cite it via `[^N|s=...]`.
    assert isinstance(env["ref"], int)
    assert env["meta"]["source_id"] == "BG"
    assert env["meta"]["tokens"] == "2.13"
    assert env["meta"]["author_id"] == "prabhupada"
    assert env["meta"]["sentences"] == [
        "Первое предложение.",
        "Второе предложение.",
        "Третье предложение.",
    ]
    assert env["label"] == "БГ 2.13 (комментарий)"
    # Alias resolves to a CommentaryRef carrying the verbatim sentences.
    resolved = aliases.resolve(env["ref"])
    assert resolved is not None
    assert resolved.item_id == "comm_xyz"  # type: ignore[union-attr]
    assert resolved.sentences == (  # type: ignore[union-attr]
        "Первое предложение.",
        "Второе предложение.",
        "Третье предложение.",
    )


def test_media_envelope_is_reference_only() -> None:
    # A media chunk is reference-only, like a verse: the envelope carries
    # the DISPLAY text + server-built label and mints a MediaRef holding
    # only the library_media id. url / type / speaker are NOT on the chunk —
    # they are resolved from library_media at flush via fetch_media(item_id).
    chunk = LibraryChunk(
        item_id="media_abc",
        item_kind="media",
        source_id=None,
        tokens="",
        author_id=None,
        doc_date=None,
        lang="ru",
        segment_index=0,
        text="Я помню, как Шрила Прабхупада...",
        addr_label="Хари Шаури · 1976",
        embed_text="facts + context + display (the embedded string)",
    )
    aliases = TurnAliasMap()
    env = library_to_envelope(chunk, alias_map=aliases, score=0.71)

    assert env["type"] == "media"
    assert isinstance(env["ref"], int)
    # DISPLAY text, not the embed_text that was vectorised.
    assert env["text"] == "Я помню, как Шрила Прабхупада..."
    assert env["label"] == "Хари Шаури · 1976"
    assert env["lang"] == "ru"
    assert env["score"] == 0.71
    # No media-specific keys in meta — resolved at serve time, not here.
    assert "media_url" not in env["meta"]
    assert "media_type" not in env["meta"]
    assert "speaker" not in env["meta"]
    assert "provenance" not in env["meta"]

    # Ref resolves to a reference-only MediaRef (id + display label/text).
    resolved = aliases.resolve(env["ref"])
    assert isinstance(resolved, MediaRef)
    assert resolved.item_id == "media_abc"
    assert resolved.label == "Хари Шаури · 1976"
    assert resolved.text == "Я помню, как Шрила Прабхупада..."
    assert resolved.lang == "ru"


def test_letter_envelope_carries_author_and_date() -> None:
    chunk = LibraryChunk(
        item_id="letter_xyz",
        item_kind="letter",
        source_id="",
        tokens="",
        author_id="prabhupada",
        doc_date="1971-05-12",
        lang="en",
        segment_index=0,
        text="My dear Yamuna...",
        addr_label="Letter to Yamuna, 1971-05-12",
    )
    env = library_to_envelope(chunk, alias_map=TurnAliasMap())

    assert env["type"] == "letter"
    # Letters are now quotable: they mint an integer ref and carry split
    # sentences, sharing the commentary `[^N|s=…]` blockquote mechanism.
    assert isinstance(env["ref"], int)
    assert env["meta"]["sentences"]  # body split for sentence-pick
    assert env["label"] == "Letter to Yamuna, 1971-05-12"
    assert env["meta"]["author_id"] == "prabhupada"
    assert env["meta"]["doc_date"] == "1971-05-12"
    # Empty source_id/tokens not propagated
    assert "source_id" not in env["meta"]
    assert "tokens" not in env["meta"]
