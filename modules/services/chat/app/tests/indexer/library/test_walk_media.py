"""`walk_media` turns each `library_media` row into ONE atomic REFERENCE
chunk.

Media rows arrive pre-chunked: `embed_text` (facts+context+text, in the
row's language) is the transient string that gets embedded — there is no
splitting. The chunk is reference-only: it carries the display `text`, the
server-built `addr_label`, and the `item_id` (= library_media id). url /
type / speaker / provenance are NOT on the chunk — they are resolved from
`library_media` at serve time via fetch_media(item_id), exactly like a
verse. `kind` is 'media' and `source_id` is None.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from shruti_chat.indexer.library.chunker import walk_media


def _seed(path: Path) -> None:
    with sqlite3.connect(str(path)) as conn:
        conn.executescript(
            """
            CREATE TABLE library_media (
                id TEXT PRIMARY KEY,
                lang TEXT,
                title TEXT,
                text TEXT,
                context TEXT,
                embed_text TEXT,
                url TEXT,
                type TEXT,
                meta TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO library_media VALUES (?,?,?,?,?,?,?,?,?)",
            (
                "m1",
                "en",
                "Morning Walk",
                "display body",
                "retrieval prefix",
                "FACTS + retrieval prefix + display body",
                "public/media/m1.mp4",
                "video",
                '{"speaker": "Srila Prabhupada", "date": "1977-01-02"}',
            ),
        )
        # A row in a language outside the requested set — must be skipped.
        conn.execute(
            "INSERT INTO library_media VALUES (?,?,?,?,?,?,?,?,?)",
            ("m2", "de", "x", "x", "x", "x", "public/media/m2.mp4", "audio", "{}"),
        )
        conn.commit()


def test_walk_media_emits_one_atomic_media_chunk(tmp_path: Path):
    db = tmp_path / "library.db"
    _seed(db)

    chunks = list(walk_media(db, langs=["en", "ru"]))

    # Only the en row; the de row is filtered out by langs.
    assert len(chunks) == 1
    c = chunks[0]

    assert c.item_kind == "media"
    assert c.item_id == "m1"
    assert c.lang == "en"
    assert c.segment_index == 0          # atomic — no splitting
    assert c.source_id is None
    # embed_text is the transient embedding string (NOT the display text);
    # it is never persisted to a chunks column.
    assert c.embed_text == "FACTS + retrieval prefix + display body"
    assert c.text == "display body"
    # No media-specific columns on the chunk — reference-only.
    assert not hasattr(c, "context")
    assert not hasattr(c, "media_url")
    assert not hasattr(c, "media_type")
    assert not hasattr(c, "meta")
    # Single server-built label: "speaker · date" when both present.
    assert c.addr_label == "Srila Prabhupada · 1977-01-02"
    # doc_date is lifted from meta for date-range filtering.
    assert c.doc_date == "1977-01-02"


def test_walk_media_label_falls_back_to_title(tmp_path: Path):
    db = tmp_path / "library.db"
    with sqlite3.connect(str(db)) as conn:
        conn.executescript(
            """
            CREATE TABLE library_media (
                id TEXT PRIMARY KEY, lang TEXT, title TEXT, text TEXT,
                context TEXT, embed_text TEXT, url TEXT, type TEXT, meta TEXT
            );
            """
        )
        conn.execute(
            "INSERT INTO library_media VALUES (?,?,?,?,?,?,?,?,?)",
            ("m3", "en", "Bhagavad-gita Class", "t", "c", "e", "u", "video", None),
        )
        conn.commit()

    chunks = list(walk_media(db, langs=["en"]))
    assert len(chunks) == 1
    assert chunks[0].addr_label == "Bhagavad-gita Class"


def test_walk_media_no_table_is_noop(tmp_path: Path):
    db = tmp_path / "library.db"
    with sqlite3.connect(str(db)) as conn:
        conn.execute("CREATE TABLE other (id TEXT)")
        conn.commit()
    assert list(walk_media(db, langs=["en"])) == []
