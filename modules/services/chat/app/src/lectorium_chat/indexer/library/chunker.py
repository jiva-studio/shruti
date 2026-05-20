"""Library content → chunks ready for embedding.

Reads from a local library.db (already bootstrapped by `library/db.py`)
and the local catalog.db (already bootstrapped by `indexer/catalog.py`,
needed for `sources.short_name` to compose human-readable `addr_label`).

Output: list of `LibraryChunk` records. The indexer turns each into one
row in the unified `chunks` Postgres table with `kind` set to the
appropriate library kind.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


MAX_CHUNK_CHARS = 900


@dataclass(frozen=True, slots=True)
class LibraryChunk:
    item_id: str
    item_kind: str       # 'verse' | 'commentary' | 'prose_chapter' | 'letter'
    source_id: str
    tokens: str
    author_id: str | None
    doc_date: str | None
    lang: str
    segment_index: int
    text: str
    addr_label: str


# ---------- catalog short_name lookup ----------

def load_source_short_names(catalog_db: Path) -> dict[tuple[str, str], str]:
    """(source_id, language) → short_name from the catalog SQLite."""
    out: dict[tuple[str, str], str] = {}
    with sqlite3.connect(f"file:{catalog_db}?mode=ro", uri=True) as conn:
        for sid, lang, short in conn.execute(
            "SELECT id, language, short_name FROM sources WHERE short_name IS NOT NULL"
        ):
            out[(sid, lang)] = short
    return out


# ---------- paragraph splitter ----------

_PARA_SPLIT = re.compile(r"\n\s*\n")
_SENT_SPLIT = re.compile(r"(?<=[.!?…])\s+(?=[А-ЯA-Z])")


def split_into_chunks(body: str, max_chars: int = MAX_CHUNK_CHARS) -> list[str]:
    """Split a markdown body into ≤max_chars chunks.

    Strategy:
      1. Strip leading/trailing whitespace.
      2. Cut on double-newline paragraphs first.
      3. If a paragraph is still too long, cut on sentence boundaries.
      4. Pack consecutive units greedily up to max_chars.
    """
    if not body:
        return []
    paragraphs = [p.strip() for p in _PARA_SPLIT.split(body.strip()) if p.strip()]
    units: list[str] = []
    for p in paragraphs:
        if len(p) <= max_chars:
            units.append(p)
            continue
        sentences = _SENT_SPLIT.split(p)
        buf = ""
        for s in sentences:
            if not s:
                continue
            if len(s) > max_chars:
                # fallback: hard-split by char window
                for i in range(0, len(s), max_chars):
                    units.append(s[i:i + max_chars])
                continue
            if len(buf) + len(s) + 1 > max_chars:
                if buf:
                    units.append(buf.strip())
                buf = s
            else:
                buf = (buf + " " + s).strip()
        if buf:
            units.append(buf.strip())
    # Greedy pack units into chunks
    chunks: list[str] = []
    cur = ""
    for u in units:
        if not cur:
            cur = u
        elif len(cur) + 2 + len(u) <= max_chars:
            cur = cur + "\n\n" + u
        else:
            chunks.append(cur)
            cur = u
    if cur:
        chunks.append(cur)
    return chunks


def hash_body(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


# ---------- addr_label composition ----------

def _verse_addr(short_name: str | None, source_id: str, tokens: str) -> str:
    label = short_name or source_id
    return f"{label} {tokens}".strip()


def _prose_chapter_addr(short_name: str | None, source_id: str,
                       tokens: str, chapter_title: str | None) -> str:
    label = short_name or source_id
    if chapter_title:
        return f"{label}, глава {tokens} «{chapter_title}»"
    return f"{label} {tokens}"


def _letter_addr(short_name: str | None, title: str | None, doc_date: str | None) -> str:
    """Compose "Letter to <recipient>, <city>, <YYYY-MM-DD>".

    `title` already carries "<recipient>, <city>" (the importer joined them
    with a comma); `doc_date` is the ISO date when known. Either may be
    NULL — fall back to a stripped form rather than emitting orphan commas.
    """
    prefix = f"Letter to {title}" if title else "Letter"
    if doc_date:
        return f"{prefix}, {doc_date}"
    return prefix


# ---------- walkers ----------

def walk_verses(
    library_db: Path,
    short_names: dict[tuple[str, str], str],
    *,
    langs: list[str],
) -> Iterator[LibraryChunk]:
    """Emit one chunk per (verse, lang) with text + IAST + translation."""
    with sqlite3.connect(f"file:{library_db}?mode=ro", uri=True) as conn:
        cur = conn.execute(
            "SELECT id, source_id, tokens, COALESCE(text,''), COALESCE(transliteration,'') "
            "FROM library_verses"
        )
        for vid, source_id, tokens, text, translit in cur:
            # Pre-fetch all translation variants for this verse
            tr_rows = conn.execute(
                "SELECT language, translation FROM library_verse_variants WHERE verse_id=?",
                (vid,),
            ).fetchall()
            translations = {lang: tr for lang, tr in tr_rows}
            for lang in langs:
                translation = translations.get(lang, "")
                if not (text or translit or translation):
                    continue
                short = short_names.get((source_id, lang))
                addr_label = _verse_addr(short, source_id, tokens)
                parts = [f"{addr_label}:"]
                if translation:
                    parts.append(translation)
                if translit:
                    parts.append(f"IAST: {translit}")
                body = "\n".join(parts).strip()
                yield LibraryChunk(
                    item_id=vid,
                    item_kind="verse",
                    source_id=source_id,
                    tokens=tokens,
                    author_id=None,
                    doc_date=None,
                    lang=lang,
                    segment_index=0,
                    text=body,
                    addr_label=addr_label,
                )


def walk_documents(
    library_db: Path,
    short_names: dict[tuple[str, str], str],
    *,
    langs: list[str],
) -> Iterator[LibraryChunk]:
    """Walk library_documents joined with their variants and titles, emitting
    one chunk per (document, lang, segment).
    """
    with sqlite3.connect(f"file:{library_db}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row

        # Load chapter titles for prose addr_label, keyed by (source_id, tokens, lang)
        titles: dict[tuple[str, str, str], str] = {}
        for r in conn.execute("SELECT source_id, tokens, language, title FROM library_titles"):
            titles[(r["source_id"], r["tokens"], r["language"])] = r["title"]

        cur = conn.execute(
            "SELECT id, source_id, tokens, author_id, kind, date FROM library_documents"
        )
        for d in cur:
            did = d["id"]
            kind = d["kind"]
            source_id = d["source_id"]
            tokens = d["tokens"]
            author_id = d["author_id"]
            doc_date = d["date"]
            variants = conn.execute(
                "SELECT language, title, body FROM library_document_variants WHERE document_id=?",
                (did,),
            ).fetchall()
            for v in variants:
                lang = v["language"]
                if lang not in langs:
                    continue
                title = v["title"]
                body = v["body"] or ""
                if not body.strip():
                    continue
                short = short_names.get((source_id, lang))
                if kind == "commentary":
                    addr_label = _verse_addr(short, source_id, tokens)
                elif kind == "prose_chapter":
                    chapter_title = titles.get((source_id, tokens, lang)) or title
                    addr_label = _prose_chapter_addr(short, source_id, tokens, chapter_title)
                elif kind == "letter":
                    addr_label = _letter_addr(short, title, doc_date)
                else:
                    addr_label = f"{short or source_id} {tokens}".strip()
                segments = split_into_chunks(body)
                for idx, seg in enumerate(segments):
                    yield LibraryChunk(
                        item_id=did,
                        item_kind=kind,
                        source_id=source_id,
                        tokens=tokens,
                        author_id=author_id,
                        doc_date=doc_date,
                        lang=lang,
                        segment_index=idx,
                        text=seg,
                        addr_label=addr_label,
                    )
