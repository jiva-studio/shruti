"""Tests for the media-clip SSE path — `MEDIA_RE` grammar + `flush_card_payloads`.

A media clip renders as a playable card on the client only if a
`media` SSE payload precedes its `[media:<id>|caption]` marker. Media
chunks are REFERENCE-ONLY: the alias carries just the `library_media` id
plus the display label/text, so `flush_card_payloads` resolves the
playback handle (relative `url`, clip `type`, optional `speaker`) from
`library_media` at turn time via fetch_media(item_id) — exactly like a
verse resolves its body via fetch_verse_body.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

import lectorium_chat.agent.graph.nodes._worker_common as wc  # noqa: F401
from lectorium_chat.agent import cards as _cards
from lectorium_chat.agent.graph.nodes._worker_common import flush_card_payloads
from lectorium_chat.agent.graph.turn_context import TurnContext
from lectorium_chat.agent.markers import MEDIA_RE


# ── MEDIA_RE grammar ─────────────────────────────────────────────────


def test_media_re_parses_id_and_caption() -> None:
    m = MEDIA_RE.search("text [media:media_abc|Хари Шаури · 1976] more")
    assert m is not None
    assert m.group(1) == "media_abc"
    assert m.group(2) == "Хари Шаури · 1976"


def test_media_re_parses_without_caption() -> None:
    m = MEDIA_RE.search("[media:media_x]")
    assert m is not None
    assert m.group(1) == "media_x"
    assert m.group(2) is None


def test_media_re_id_charset() -> None:
    # Opaque ids with underscore / dot / dash are accepted.
    m = MEDIA_RE.search("[media:clip.7-abc_DEF]")
    assert m is not None
    assert m.group(1) == "clip.7-abc_DEF"


# ── flush_card_payloads SSE shape ───────────────────────────────────


def _seed_media(
    path: Path,
    *,
    media_id: str,
    url: str,
    mtype: str,
    meta: str | None,
) -> None:
    """Write one `library_media` row into a temp SQLite library.db."""
    with sqlite3.connect(str(path)) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS library_media (
                id TEXT PRIMARY KEY, lang TEXT, title TEXT, text TEXT,
                context TEXT, embed_text TEXT, url TEXT, type TEXT, meta TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO library_media VALUES (?,?,?,?,?,?,?,?,?)",
            (media_id, "ru", "title", "body", "ctx", "embed", url, mtype, meta),
        )
        conn.commit()


@pytest.fixture
def capture_writer(monkeypatch):
    events: list[dict] = []
    monkeypatch.setattr(_cards, "get_stream_writer", lambda: events.append)
    return events


async def test_flush_resolves_full_payload_via_fetch_media(
    capture_writer, tmp_path: Path
) -> None:
    db = tmp_path / "library.db"
    _seed_media(
        db,
        media_id="media_abc",
        url="media/clips/abc.mp4",
        mtype="video",
        meta='{"speaker": "Хари Шаури", "date": "1976"}',
    )
    ctx = TurnContext(library_db_path=db)
    ctx.aliases.alias_media(
        "media_abc",
        label="Хари Шаури · 1976",
        text="Я помню, как Шрила Прабхупада...",
    )

    await flush_card_payloads(ctx)

    assert len(capture_writer) == 1
    ev = capture_writer[0]
    assert ev["type"] == "action"
    assert ev["data"]["kind"] == "media"
    assert ev["data"]["id"] == "media_media_abc"
    payload = ev["data"]["payload"]
    assert payload["id"] == "media_abc"
    # url / type / speaker are resolved from library_media, not the chunk.
    assert payload["url"] == "media/clips/abc.mp4"   # relative path
    assert payload["type"] == "video"
    assert payload["title"] == "Хари Шаури · 1976"   # label from the alias
    assert payload["speaker"] == "Хари Шаури"
    # text is the display string carried on the alias (envelope time).
    assert payload["text"] == "Я помню, как Шрила Прабхупада..."
    assert ("media", ("media_abc",)) in ctx.emitted_card_keys


async def test_flush_omits_speaker_when_absent(
    capture_writer, tmp_path: Path
) -> None:
    db = tmp_path / "library.db"
    _seed_media(
        db, media_id="media_x", url="media/clips/x.mp3", mtype="audio", meta="{}"
    )
    ctx = TurnContext(library_db_path=db)
    ctx.aliases.alias_media("media_x", label="Untitled clip")

    await flush_card_payloads(ctx)

    assert len(capture_writer) == 1
    payload = capture_writer[0]["data"]["payload"]
    assert "speaker" not in payload
    assert payload["type"] == "audio"


async def test_flush_dedups_within_turn(
    capture_writer, tmp_path: Path
) -> None:
    db = tmp_path / "library.db"
    _seed_media(
        db, media_id="media_a", url="u", mtype="video", meta=None
    )
    ctx = TurnContext(library_db_path=db)
    ctx.aliases.alias_media("media_a", label="L")

    await flush_card_payloads(ctx)
    await flush_card_payloads(ctx)  # second call must not re-emit

    assert len(capture_writer) == 1


async def test_flush_skips_when_row_absent(
    capture_writer, tmp_path: Path
) -> None:
    # Alias points at an id with no library_media row → no payload emitted.
    db = tmp_path / "library.db"
    _seed_media(
        db, media_id="present", url="u", mtype="video", meta=None
    )
    ctx = TurnContext(library_db_path=db)
    ctx.aliases.alias_media("missing", label="L")

    await flush_card_payloads(ctx)
    assert capture_writer == []


async def test_flush_no_aliases_is_noop(capture_writer, tmp_path: Path) -> None:
    ctx = TurnContext(library_db_path=tmp_path / "library.db")
    await flush_card_payloads(ctx)
    assert capture_writer == []


async def test_flush_no_library_db_is_noop(capture_writer) -> None:
    ctx = TurnContext()  # library_db_path is None
    ctx.aliases.alias_media("media_a", label="L")
    await flush_card_payloads(ctx)
    assert capture_writer == []
