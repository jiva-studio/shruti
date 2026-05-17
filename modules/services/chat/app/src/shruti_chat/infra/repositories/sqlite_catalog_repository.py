"""SQLite-backed `CatalogRepository`.

Reads from the catalog DB (`current.db`) which the indexer downloads
and atomically swaps. Each call opens a fresh read-only connection so
post-swap connections see the new inode.

The dictionary cache (authors / sources / locations / tags) is a
module-level structure because the same data is consumed by every
`resolve` call across requests; we drop it via `invalidate_dict_cache`
on each catalog swap. After phase 7 the cache moves onto the
repository instance and the function-level hook goes away.

SQL bodies were moved verbatim from `agent/tools/{tracks,list_tracks,resolve,search}.py`
to keep behaviour identical — same FTS folding (`_fts.matches`), same
EXISTS-style joins, same author/location/tag fallback joins.
"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from rapidfuzz import fuzz, process, utils

from shruti_chat.agent.tools._fts import matches as _title_matches, tokens as _title_tokens
from shruti_chat.config import get_settings
from shruti_chat.domain.entities import Reference, ResolvedEntity, Track
from shruti_chat.domain.ports.catalog_repository import ResolveKind


# --- read-only sqlite connection -------------------------------------------

@contextmanager
def _catalog_conn() -> Iterator[sqlite3.Connection]:
    path: Path = get_settings().catalog_db_path
    if not path.exists():
        raise RuntimeError(
            f"catalog DB not found at {path}; indexer not bootstrapped"
        )
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


# --- dictionary cache (for resolve) ----------------------------------------

@dataclass(frozen=True)
class _CacheKey:
    table: str
    lang: str | None


@dataclass
class _DictRow:
    id: str
    full_name: str
    extra: dict[str, Any]


_lock = threading.Lock()
_cache: dict[_CacheKey, list[_DictRow]] = {}


def invalidate_dict_cache() -> None:
    """Called by the indexer after a catalog swap."""
    with _lock:
        _cache.clear()


_RESOLVE_TABLES = {
    "author":   ("authors",   []),
    "source":   ("sources",   ["short_name"]),
    "location": ("locations", []),
    "tag":      ("tags",      []),
}


def _load_dict(table: str, lang: str | None, extra_fields: list[str]) -> list[_DictRow]:
    key = _CacheKey(table, lang)
    with _lock:
        cached = _cache.get(key)
        if cached is not None:
            return cached
    select_cols = ["id", "full_name"] + extra_fields
    sql = f"SELECT {', '.join(select_cols)} FROM {table}"
    params: tuple = ()
    if lang:
        sql += " WHERE language = ?"
        params = (lang,)
    with _catalog_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    out = [
        _DictRow(
            id=r["id"],
            full_name=r["full_name"],
            extra={c: r[c] for c in extra_fields},
        )
        for r in rows
    ]
    with _lock:
        _cache[key] = out
    return out


def _fuzzy_top(query: str, rows: list[_DictRow], limit: int) -> list[tuple[_DictRow, float]]:
    if not rows or not query.strip():
        return []
    matches = process.extract(
        query,
        {r.id: r.full_name for r in rows},
        scorer=fuzz.token_set_ratio,
        processor=utils.default_process,
        limit=limit,
        score_cutoff=40,
    )
    by_id = {r.id: r for r in rows}
    return [(by_id[mid], score / 100.0) for (_name, score, mid) in matches]


# --- sync SQL bodies (moved from agent/tools/*) -----------------------------

def _filter_track_ids_sync(
    *,
    author_id: str | None,
    source_id: str | None,
    location_id: str | None,
    tag_ids: list[str] | None,
    date_from: str | None,
    date_to: str | None,
) -> list[str] | None:
    if not any([author_id, source_id, location_id, tag_ids, date_from, date_to]):
        return None
    sql = ["SELECT t.id FROM tracks t WHERE t.hidden = 0"]
    params: list[Any] = []
    if author_id:
        sql.append("AND t.author_id = ?"); params.append(author_id)
    if location_id:
        sql.append("AND t.location_id = ?"); params.append(location_id)
    if date_from:
        sql.append("AND t.date >= ?"); params.append(date_from)
    if date_to:
        sql.append("AND t.date <= ?"); params.append(date_to)
    if tag_ids:
        ph = ",".join("?" * len(tag_ids))
        sql.append(
            f"AND EXISTS (SELECT 1 FROM track_tags "
            f"WHERE track_id = t.id AND tag_id IN ({ph}))"
        )
        params.extend(tag_ids)
    if source_id:
        sql.append(
            "AND EXISTS (SELECT 1 FROM track_references "
            "WHERE track_id = t.id AND source_id = ?)"
        )
        params.append(source_id)
    with _catalog_conn() as conn:
        return [r["id"] for r in conn.execute("\n".join(sql), params).fetchall()]


def _get_track_sync(track_id: str, lang: str) -> Track | None:
    with _catalog_conn() as conn:
        track = conn.execute(
            "SELECT id, author_id, location_id, date, hidden FROM tracks WHERE id = ?",
            (track_id,),
        ).fetchone()
        if track is None or track["hidden"] == 1:
            return None

        variant = conn.execute(
            """
            SELECT title, language, audio_duration FROM track_variants
            WHERE track_id = ?
            ORDER BY CASE language WHEN ? THEN 0 WHEN 'en' THEN 1 ELSE 2 END
            LIMIT 1
            """,
            (track_id, lang),
        ).fetchone()
        languages = tuple(
            r["language"] for r in conn.execute(
                "SELECT language FROM track_variants WHERE track_id = ?",
                (track_id,),
            ).fetchall()
        )

        author_name: str | None = None
        if track["author_id"]:
            row = conn.execute(
                "SELECT full_name FROM authors WHERE id = ? AND language = ?",
                (track["author_id"], lang),
            ).fetchone()
            author_name = row["full_name"] if row else None

        location_name: str | None = None
        if track["location_id"]:
            row = conn.execute(
                "SELECT full_name FROM locations WHERE id = ? AND language = ?",
                (track["location_id"], lang),
            ).fetchone()
            location_name = row["full_name"] if row else None

        tag_rows = conn.execute(
            """
            SELECT tt.tag_id, tg.full_name
            FROM track_tags tt
            LEFT JOIN tags tg ON tg.id = tt.tag_id AND tg.language = ?
            WHERE tt.track_id = ?
            """,
            (lang, track_id),
        ).fetchall()

        ref_rows = conn.execute(
            """
            SELECT tr.source_id, tr.tokens, s.full_name, s.short_name
            FROM track_references tr
            LEFT JOIN sources s ON s.id = tr.source_id AND s.language = ?
            WHERE tr.track_id = ?
            ORDER BY tr.ref_idx
            """,
            (lang, track_id),
        ).fetchall()

        return Track(
            id=track_id,
            title=variant["title"] if variant else None,
            lang=variant["language"] if variant else lang,
            date=track["date"],
            author_id=track["author_id"],
            author_name=author_name,
            location_id=track["location_id"],
            location_name=location_name,
            tag_ids=tuple(r["tag_id"] for r in tag_rows),
            tag_names=tuple((r["full_name"] or r["tag_id"]) for r in tag_rows),
            duration_ms=variant["audio_duration"] if variant else None,
            references=tuple(
                Reference(
                    source_id=r["source_id"],
                    full_name=r["full_name"],
                    short_name=r["short_name"],
                    tokens=r["tokens"],
                )
                for r in ref_rows
            ),
            languages=languages,
        )


def _list_tracks_sync(
    *,
    author_id: str | None,
    source_id: str | None,
    location_id: str | None,
    tag_ids: list[str] | None,
    title_query: str | None,
    date_from: str | None,
    date_to: str | None,
    lang: str | None,
    limit: int,
    offset: int,
) -> list[Track]:
    # When lang is None, fall back to "en" for the title-lookup join, but
    # skip the EXISTS-filter so all languages remain visible.
    title_lang = lang or "en"
    with _catalog_conn() as conn:
        params: list[Any] = []
        sql = [
            "SELECT t.id AS track_id, t.date, t.author_id, t.location_id,",
            "       tv.title AS title_req, tv.audio_duration AS duration_ms,",
            "       tv.language AS lang_actual",
            "FROM tracks t",
            "LEFT JOIN track_variants tv ON tv.track_id = t.id AND tv.language = ?",
            "WHERE t.hidden = 0",
        ]
        params.append(title_lang)
        if lang:
            sql.append(
                "AND EXISTS (SELECT 1 FROM track_variants tv2 "
                "WHERE tv2.track_id = t.id AND tv2.language = ? "
                "AND tv2.transcript_path IS NOT NULL)"
            )
            params.append(lang)
        if author_id:
            sql.append("AND t.author_id = ?"); params.append(author_id)
        if location_id:
            sql.append("AND t.location_id = ?"); params.append(location_id)
        if date_from:
            sql.append("AND t.date >= ?"); params.append(date_from)
        if date_to:
            sql.append("AND t.date <= ?"); params.append(date_to)
        if tag_ids:
            placeholders = ",".join("?" * len(tag_ids))
            sql.append(
                f"AND EXISTS (SELECT 1 FROM track_tags "
                f"WHERE track_id = t.id AND tag_id IN ({placeholders}))"
            )
            params.extend(tag_ids)
        if source_id:
            sql.append(
                "AND EXISTS (SELECT 1 FROM track_references "
                "WHERE track_id = t.id AND source_id = ?)"
            )
            params.append(source_id)
        if title_query:
            qtoks = _title_tokens(title_query)
            if qtoks:
                rows_by_title = conn.execute(
                    "SELECT DISTINCT track_id, title FROM track_variants"
                ).fetchall()
                matched_ids = {r["track_id"] for r in rows_by_title
                               if _title_matches(r["title"], qtoks)}
                if not matched_ids:
                    return []
                ph_m = ",".join("?" * len(matched_ids))
                sql.append(f"AND t.id IN ({ph_m})")
                params.extend(matched_ids)
        sql.append("ORDER BY t.date DESC NULLS LAST")
        sql.append("LIMIT ? OFFSET ?")
        params.extend([limit, offset])

        rows = conn.execute("\n".join(sql), params).fetchall()
        if not rows:
            return []

        track_ids = [r["track_id"] for r in rows]
        ph_t = ",".join("?" * len(track_ids))

        # Fallback titles for tracks missing the requested-lang variant
        missing = [r["track_id"] for r in rows if r["title_req"] is None]
        fallback_titles: dict[str, tuple[str, str, int | None]] = {}
        if missing:
            ph_m = ",".join("?" * len(missing))
            fb_rows = conn.execute(
                f"""
                SELECT track_id, title, language, audio_duration
                FROM track_variants
                WHERE track_id IN ({ph_m})
                ORDER BY CASE language WHEN 'en' THEN 0 ELSE 1 END
                """,
                missing,
            ).fetchall()
            for r in fb_rows:
                fallback_titles.setdefault(
                    r["track_id"],
                    (r["title"], r["language"], r["audio_duration"]),
                )

        # Author + location names
        author_ids = sorted({r["author_id"] for r in rows if r["author_id"]})
        location_ids = sorted({r["location_id"] for r in rows if r["location_id"]})
        author_names: dict[str, str] = {}
        if author_ids:
            ph = ",".join("?" * len(author_ids))
            for r in conn.execute(
                f"SELECT id, full_name FROM authors "
                f"WHERE id IN ({ph}) AND language = ?",
                [*author_ids, title_lang],
            ).fetchall():
                author_names[r["id"]] = r["full_name"]
        location_names: dict[str, str] = {}
        if location_ids:
            ph = ",".join("?" * len(location_ids))
            for r in conn.execute(
                f"SELECT id, full_name FROM locations "
                f"WHERE id IN ({ph}) AND language = ?",
                [*location_ids, title_lang],
            ).fetchall():
                location_names[r["id"]] = r["full_name"]

        # Tags per track
        track_tags: dict[str, list[tuple[str, str]]] = {}
        tag_rows = conn.execute(
            f"""
            SELECT tt.track_id, tt.tag_id, tg.full_name
            FROM track_tags tt
            LEFT JOIN tags tg ON tg.id = tt.tag_id AND tg.language = ?
            WHERE tt.track_id IN ({ph_t})
            """,
            [title_lang, *track_ids],
        ).fetchall()
        for r in tag_rows:
            track_tags.setdefault(r["track_id"], []).append(
                (r["tag_id"], r["full_name"] or r["tag_id"])
            )

        # References per track
        track_refs: dict[str, list[Reference]] = {}
        ref_rows = conn.execute(
            f"""
            SELECT tr.track_id, tr.source_id, tr.tokens, s.short_name, s.full_name
            FROM track_references tr
            LEFT JOIN sources s ON s.id = tr.source_id AND s.language = ?
            WHERE tr.track_id IN ({ph_t})
            ORDER BY tr.track_id, tr.ref_idx
            """,
            [title_lang, *track_ids],
        ).fetchall()
        for r in ref_rows:
            track_refs.setdefault(r["track_id"], []).append(
                Reference(
                    source_id=r["source_id"],
                    full_name=r["full_name"],
                    short_name=r["short_name"],
                    tokens=r["tokens"],
                )
            )

        out: list[Track] = []
        for r in rows:
            tid = r["track_id"]
            title = r["title_req"]
            actual_lang = r["lang_actual"] or title_lang
            duration = r["duration_ms"]
            if title is None and tid in fallback_titles:
                title, actual_lang, duration = fallback_titles[tid]
            tags = track_tags.get(tid, [])
            out.append(
                Track(
                    id=tid,
                    title=title,
                    lang=actual_lang,
                    date=r["date"],
                    author_id=r["author_id"],
                    author_name=author_names.get(r["author_id"]) if r["author_id"] else None,
                    location_id=r["location_id"],
                    location_name=location_names.get(r["location_id"]) if r["location_id"] else None,
                    tag_ids=tuple(t[0] for t in tags),
                    tag_names=tuple(t[1] for t in tags),
                    duration_ms=duration,
                    references=tuple(track_refs.get(tid, [])),
                )
            )
        return out


def _filter_existing_track_ids_sync(track_ids: list[str]) -> list[str]:
    if not track_ids:
        return []
    placeholders = ",".join("?" * len(track_ids))
    with _catalog_conn() as conn:
        rows = conn.execute(
            f"SELECT id FROM tracks WHERE hidden = 0 AND id IN ({placeholders})",
            list(track_ids),
        ).fetchall()
    return [r["id"] for r in rows]


def _resolve_transcript_path_sync(
    track_id: str, requested_lang: str,
) -> tuple[str | None, str]:
    with _catalog_conn() as conn:
        row = conn.execute(
            "SELECT transcript_path FROM track_variants "
            "WHERE track_id = ? AND language = ? "
            "  AND transcript_path IS NOT NULL AND transcript_path <> ''",
            (track_id, requested_lang),
        ).fetchone()
        if row and row["transcript_path"]:
            return row["transcript_path"], requested_lang
        row = conn.execute(
            "SELECT language, transcript_path FROM track_variants "
            "WHERE track_id = ? "
            "  AND transcript_path IS NOT NULL AND transcript_path <> '' "
            "LIMIT 1",
            (track_id,),
        ).fetchone()
        if row and row["transcript_path"]:
            return row["transcript_path"], str(row["language"])
    return None, requested_lang


def _resolve_sync(
    kind: ResolveKind,
    text: str,
    lang: str | None,
    limit: int,
) -> list[ResolvedEntity]:
    table, extra_fields = _RESOLVE_TABLES[kind]
    rows = _load_dict(table, lang, extra_fields)
    return [
        ResolvedEntity(
            id=row.id,
            full_name=row.full_name,
            confidence=round(score, 3),
            extra=dict(row.extra),
        )
        for row, score in _fuzzy_top(text, rows, limit)
    ]


# --- repository -------------------------------------------------------------

class SqliteCatalogRepository:
    async def get_track(self, track_id: str, *, lang: str) -> Track | None:
        return await asyncio.to_thread(_get_track_sync, track_id, lang)

    async def filter_existing_track_ids(self, track_ids: list[str]) -> list[str]:
        return await asyncio.to_thread(_filter_existing_track_ids_sync, track_ids)

    async def resolve_transcript_path(
        self, track_id: str, *, requested_lang: str,
    ) -> tuple[str | None, str]:
        return await asyncio.to_thread(
            _resolve_transcript_path_sync, track_id, requested_lang,
        )

    async def list_tracks(
        self,
        *,
        author_id: str | None,
        source_id: str | None,
        location_id: str | None,
        tag_ids: list[str] | None,
        title_query: str | None,
        date_from: str | None,
        date_to: str | None,
        lang: str | None,
        limit: int,
        offset: int,
    ) -> list[Track]:
        return await asyncio.to_thread(
            _list_tracks_sync,
            author_id=author_id,
            source_id=source_id,
            location_id=location_id,
            tag_ids=tag_ids,
            title_query=title_query,
            date_from=date_from,
            date_to=date_to,
            lang=lang,
            limit=limit,
            offset=offset,
        )

    async def filter_track_ids(
        self,
        *,
        author_id: str | None,
        source_id: str | None,
        location_id: str | None,
        tag_ids: list[str] | None,
        date_from: str | None,
        date_to: str | None,
    ) -> list[str] | None:
        return await asyncio.to_thread(
            _filter_track_ids_sync,
            author_id=author_id,
            source_id=source_id,
            location_id=location_id,
            tag_ids=tag_ids,
            date_from=date_from,
            date_to=date_to,
        )

    async def resolve(
        self,
        kind: ResolveKind,
        text: str,
        *,
        lang: str | None,
        limit: int,
    ) -> list[ResolvedEntity]:
        return await asyncio.to_thread(_resolve_sync, kind, text, lang, limit)

    def invalidate_cache(self) -> None:
        invalidate_dict_cache()
