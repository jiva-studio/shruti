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
import os
import shutil
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from rapidfuzz import fuzz, process, utils

from shruti_chat.agent.tools._fts import matches as _title_matches, tokens as _title_tokens
from shruti_chat.domain.entities import Collection, Reference, ResolvedEntity, Track
from shruti_chat.domain.ports.catalog_repository import ResolveKind
from shruti_chat.infra.repositories._ref_filter import (
    matches_ref as _matches_ref,
    parse_tokens as _parse_tokens,
    parse_user_prefix as _parse_user_prefix,
)


# Each sync helper takes `db_path` explicitly so they can be tested in
# isolation. The repository instance below holds the path and threads
# it through.


# --- /dev/shm-backed catalog mirror ----------------------------------------
#
# On Linux containers `/dev/shm` is a tmpfs — files written there live
# entirely in RAM. The catalog DB is small (~50 MB) and read-only between
# indexer swaps, so mirroring it to /dev/shm eliminates every page-cache
# miss without giving up multi-connection concurrency (a single
# in-memory connection with check_same_thread=False would serialise
# every catalog read behind a global lock and kill fanout parallelism).
#
# The mirror is refreshed lazily by comparing inode + mtime + size; the
# indexer's atomic `os.replace` of the on-disk DB changes the inode,
# which is what we watch. No explicit invalidate hook required.

_SHM_DIR = Path("/dev/shm")
_mirror_lock = threading.Lock()
# (source_path, source_stat_signature) -> mirror_path
_mirror_cache: dict[tuple[str, tuple[int, int, int]], Path] = {}


def _stat_signature(path: Path) -> tuple[int, int, int] | None:
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    # ino + mtime_ns + size: changes on indexer swap (new inode) and on
    # in-place rewrites that preserve the inode (mtime + size move).
    return (st.st_ino, st.st_mtime_ns, st.st_size)


def _mirror_path_for(source: Path) -> Path:
    """Return a `/dev/shm` mirror of `source`, copying on first call and
    on every source change. Falls back to `source` itself if /dev/shm
    isn't writable (macOS dev hosts) — behaviour is unchanged there."""
    sig = _stat_signature(source)
    if sig is None:
        return source
    key = (str(source), sig)
    cached = _mirror_cache.get(key)
    if cached is not None and cached.exists():
        return cached
    if not _SHM_DIR.exists() or not os.access(_SHM_DIR, os.W_OK):
        return source
    with _mirror_lock:
        cached = _mirror_cache.get(key)
        if cached is not None and cached.exists():
            return cached
        # Use a stable name keyed on source-path hash + pid so multiple
        # workers in the same container don't trample each other.
        suffix = source.name.replace(os.sep, "_")
        mirror = _SHM_DIR / f"shruti_catalog_{os.getpid()}_{suffix}"
        tmp = mirror.with_suffix(mirror.suffix + ".tmp")
        try:
            shutil.copy2(source, tmp)
            os.replace(tmp, mirror)
        except OSError:
            # No space in /dev/shm or any other tmpfs issue — give up on
            # the mirror, the on-disk path still works.
            tmp.unlink(missing_ok=True)
            return source
        # Drop stale mirrors for the SAME source path so we don't leak
        # /dev/shm space on every indexer swap.
        for stale_key in [k for k in _mirror_cache if k[0] == str(source) and k != key]:
            stale = _mirror_cache.pop(stale_key, None)
            if stale and stale != mirror:
                stale.unlink(missing_ok=True)
        _mirror_cache[key] = mirror
        return mirror


@contextmanager
def _catalog_conn(path: Path) -> Iterator[sqlite3.Connection]:
    if not path.exists():
        raise RuntimeError(
            f"catalog DB not found at {path}; indexer not bootstrapped"
        )
    effective = _mirror_path_for(path)
    uri = f"file:{effective}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    # mmap_size lets SQLite use mmap on the underlying file. For an
    # already-in-RAM /dev/shm mirror this is essentially free; for the
    # fallback path it gives the kernel a hint to keep pages hot.
    try:
        conn.execute("PRAGMA mmap_size = 67108864")  # 64 MB
    except sqlite3.OperationalError:
        # Some builds don't support mmap; harmless to skip.
        pass
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


def _normalize_source_id(
    db_path: Path, source_id: str | None
) -> str | None:
    """Accept either an opaque catalog id (`source_<base62>`) or a short
    name (`BG`, `СB`, `БГ`, `ШБ`) and return the opaque id.

    The agent's router and the LLM in the catalog worker both tend to
    pass short names — that's the natural shape extracted from user
    queries like «Гита 2», «БГ 2.13», "SB 5.5.3". The catalog DB
    indexes by opaque id (`source_dsicuBsFvinZ` etc.); accepting only
    that form meant short-name calls silently filtered to zero matches.

    Resolution rules:
    - None / empty → None (no filter)
    - Starts with `source_` → already opaque, returned as-is
    - Otherwise → case-insensitive `short_name` lookup across all
      languages (BG and БГ both resolve to the Bhagavad-gītā opaque id)
    - No match → None (drops the filter rather than producing 0 rows)
    """
    if not source_id:
        return None
    if source_id.startswith("source_"):
        return source_id
    needle = source_id.strip().casefold()
    if not needle:
        return None
    # SQLite's built-in LOWER() is ASCII-only, so "БГ" wouldn't match.
    # The `sources` table is small (~10 sources × 2 langs), so we
    # fetch all short_names and compare with Python's `casefold()`
    # (which DOES handle Cyrillic and other scripts).
    try:
        with _catalog_conn(db_path) as conn:
            rows = conn.execute("SELECT id, short_name FROM sources").fetchall()
    except sqlite3.Error:
        return None
    for r in rows:
        sn = r["short_name"] or ""
        if sn.strip().casefold() == needle:
            return r["id"]
    return None


def _load_dict(
    db_path: Path,
    table: str,
    lang: str | None,
    extra_fields: list[str],
) -> list[_DictRow]:
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
    with _catalog_conn(db_path) as conn:
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
    # Match against full_name AND short_name (when present, e.g. sources:
    # "БГ"/"BG"/"CC Madhya"). Without the short_name in the pool, an
    # abbreviation query scores near-zero against the full name and the
    # address classifier / source filter silently miss. Parallel lists let
    # one id own several matchable strings; we keep the best score per id.
    choices: list[str] = []
    owners: list[str] = []
    for r in rows:
        choices.append(r.full_name)
        owners.append(r.id)
        short = r.extra.get("short_name")
        if short:
            choices.append(short)
            owners.append(r.id)
    matches = process.extract(
        query,
        choices,
        scorer=fuzz.token_set_ratio,
        processor=utils.default_process,
        limit=limit * 2,
        score_cutoff=40,
    )
    by_id = {r.id: r for r in rows}
    best: dict[str, float] = {}
    for (_text, score, idx) in matches:
        oid = owners[idx]
        best[oid] = max(best.get(oid, 0.0), score)
    ranked = sorted(best.items(), key=lambda kv: -kv[1])[:limit]
    return [(by_id[oid], score / 100.0) for oid, score in ranked]


# --- sync SQL bodies (moved from agent/tools/*) -----------------------------

def _filter_track_ids_sync(
    db_path: Path,
    *,
    author_id: str | None,
    source_id: str | None,
    location_id: str | None,
    tag_ids: list[str] | None,
    date_from: str | None,
    date_to: str | None,
) -> list[str] | None:
    source_id = _normalize_source_id(db_path, source_id)
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
    with _catalog_conn(db_path) as conn:
        return [r["id"] for r in conn.execute("\n".join(sql), params).fetchall()]


def _get_track_sync(db_path: Path, track_id: str, lang: str) -> Track | None:
    with _catalog_conn(db_path) as conn:
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


def _get_titles_sync(
    db_path: Path, track_ids: list[str], lang: str | None,
) -> dict[str, str]:
    """Batch track_id → title in the caller's preferred language.

    One query for the whole set (the chat research panel resolves a handful
    of lecture titles per round); language preference mirrors `_get_track_sync`
    (requested lang, then en, then anything). Missing/blank titles are simply
    absent from the map — the caller decides what to do with an unresolved id.
    """
    ids = [t for t in track_ids if t]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    with _catalog_conn(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT track_id, title, language FROM track_variants
            WHERE track_id IN ({placeholders})
            ORDER BY track_id,
                     CASE language WHEN ? THEN 0 WHEN 'en' THEN 1 ELSE 2 END
            """,
            (*ids, lang or "en"),
        ).fetchall()
    out: dict[str, str] = {}
    for r in rows:
        tid = r["track_id"]
        if tid in out:  # first row per track_id wins → honours the lang order
            continue
        title = (r["title"] or "").strip()
        if title:
            out[tid] = title
    return out


def _topic_weights_for_tracks_sync(
    db_path: Path, track_ids: list[str],
) -> list[tuple[str, str, float]]:
    """`(track_id, topic_id, weight)` for the given tracks — the raw signal
    the taste profile is built from. Mirrors mobile `weightsForTracks`."""
    ids = [t for t in track_ids if t]
    if not ids:
        return []
    placeholders = ",".join("?" * len(ids))
    with _catalog_conn(db_path) as conn:
        rows = conn.execute(
            f"SELECT track_id, topic_id, weight FROM track_topics "
            f"WHERE track_id IN ({placeholders})",
            (*ids,),
        ).fetchall()
    return [(r["track_id"], r["topic_id"], float(r["weight"])) for r in rows]


def _top_track_ids_for_topic_sync(
    db_path: Path, topic_id: str, languages: list[str], limit: int,
) -> list[str]:
    """Highest-weight tracks on a topic, optionally language-constrained.

    EXISTS (not a JOIN) so a track with several matching variants stays a
    single row — mirrors the mobile `topTrackIds` SQL verbatim."""
    langs = [code for code in languages if code]
    with _catalog_conn(db_path) as conn:
        if not langs:
            rows = conn.execute(
                "SELECT track_id FROM track_topics WHERE topic_id = ? "
                "ORDER BY weight DESC LIMIT ?",
                (topic_id, limit),
            ).fetchall()
        else:
            placeholders = ",".join("?" * len(langs))
            rows = conn.execute(
                f"SELECT tt.track_id FROM track_topics tt "
                f"WHERE tt.topic_id = ? AND EXISTS ("
                f"  SELECT 1 FROM track_variants tv "
                f"  WHERE tv.track_id = tt.track_id AND tv.language IN ({placeholders})"
                f") ORDER BY tt.weight DESC LIMIT ?",
                (topic_id, *langs, limit),
            ).fetchall()
    return [r["track_id"] for r in rows]


def _topic_names_sync(
    db_path: Path, topic_ids: list[str], lang: str,
) -> dict[str, str]:
    """Batch topic_id → display name, requested lang then en fallback."""
    ids = [t for t in topic_ids if t]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    with _catalog_conn(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT id, full_name, short_name, language FROM topics
            WHERE id IN ({placeholders})
            ORDER BY id,
                     CASE language WHEN ? THEN 0 WHEN 'en' THEN 1 ELSE 2 END
            """,
            (*ids, lang),
        ).fetchall()
    out: dict[str, str] = {}
    for r in rows:
        tid = r["id"]
        if tid in out:  # first row per id wins → honours the lang order
            continue
        name = (r["full_name"] or r["short_name"] or "").strip()
        if name:
            out[tid] = name
    return out


def _filter_track_ids_by_ref(
    conn: sqlite3.Connection,
    *,
    source_id: str | None,
    ref_prefix: str | None,
    ref_from: int | None,
    ref_to: int | None,
) -> set[str]:
    """Scan `track_references` and return matching track_ids.

    The full set has ~5k rows in production — Python-side filtering is
    sub-millisecond, and the dot-separated `tokens` format isn't
    practical to filter from SQL. Parser + matcher live in
    `_ref_filter` so they can be unit-tested without the agent stack.
    """
    sql = "SELECT track_id, tokens FROM track_references WHERE tokens IS NOT NULL"
    params: list[Any] = []
    if source_id:
        sql += " AND source_id = ?"
        params.append(source_id)
    user_prefix = _parse_user_prefix(ref_prefix)
    if user_prefix is None:
        return set()
    out: set[str] = set()
    for row in conn.execute(sql, params):
        parsed = _parse_tokens(row["tokens"])
        if parsed is None:
            continue
        if _matches_ref(parsed, user_prefix, ref_from, ref_to):
            out.add(row["track_id"])
    return out


def _list_tracks_sync(
    db_path: Path,
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
    ref_prefix: str | None = None,
    ref_from: int | None = None,
    ref_to: int | None = None,
) -> list[Track]:
    source_id = _normalize_source_id(db_path, source_id)
    # When lang is None, fall back to "en" for the title-lookup join, but
    # skip the EXISTS-filter so all languages remain visible.
    title_lang = lang or "en"
    with _catalog_conn(db_path) as conn:
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
        if ref_prefix is not None or ref_from is not None or ref_to is not None:
            ref_ids = _filter_track_ids_by_ref(
                conn,
                source_id=source_id,
                ref_prefix=ref_prefix,
                ref_from=ref_from,
                ref_to=ref_to,
            )
            if not ref_ids:
                return []
            ph_r = ",".join("?" * len(ref_ids))
            sql.append(f"AND t.id IN ({ph_r})")
            params.extend(ref_ids)
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


def _get_author_names_sync(
    db_path: Path, author_ids: list[str], lang: str,
) -> dict[str, str]:
    unique_ids = list({i for i in author_ids if i})
    if not unique_ids:
        return {}
    placeholders = ",".join("?" * len(unique_ids))
    out: dict[str, str] = {}
    with _catalog_conn(db_path) as conn:
        rows = conn.execute(
            f"SELECT id, full_name FROM authors "
            f"WHERE id IN ({placeholders}) AND language = ?",
            [*unique_ids, lang],
        ).fetchall()
        for r in rows:
            out[r["id"]] = r["full_name"]
        missing = [i for i in unique_ids if i not in out]
        if missing:
            # Native lang lookup empty for some — fall back to any
            # available language (usually 'en') so we still produce a
            # human-readable name instead of leaking an opaque id.
            ph2 = ",".join("?" * len(missing))
            fb_rows = conn.execute(
                f"SELECT id, full_name FROM authors "
                f"WHERE id IN ({ph2}) "
                f"ORDER BY CASE language WHEN 'en' THEN 0 ELSE 1 END",
                missing,
            ).fetchall()
            for r in fb_rows:
                out.setdefault(r["id"], r["full_name"])
    return out


def _filter_existing_track_ids_sync(db_path: Path, track_ids: list[str]) -> list[str]:
    if not track_ids:
        return []
    placeholders = ",".join("?" * len(track_ids))
    with _catalog_conn(db_path) as conn:
        rows = conn.execute(
            f"SELECT id FROM tracks WHERE hidden = 0 AND id IN ({placeholders})",
            list(track_ids),
        ).fetchall()
    return [r["id"] for r in rows]


def _resolve_transcript_path_sync(
    db_path: Path, track_id: str, requested_lang: str,
) -> tuple[str | None, str]:
    with _catalog_conn(db_path) as conn:
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


def _source_short_label_sync(db_path: Path, source_id: str, lang: str) -> str | None:
    """short_name for a source in `lang`, falling back to en then any."""
    try:
        with _catalog_conn(db_path) as conn:
            rows = conn.execute(
                "SELECT language, short_name FROM sources WHERE id = ?",
                (source_id,),
            ).fetchall()
    except sqlite3.Error:
        return None
    by_lang = {r["language"]: r["short_name"] for r in rows if r["short_name"]}
    return by_lang.get(lang) or by_lang.get("en") or next(iter(by_lang.values()), None)


def _language_name_sync(db_path: Path, code: str) -> str | None:
    """Native language name for a locale code from the `languages` table
    ("ru"→"Русский", "sr-Latn"→"Srpski", "hi"→"हिन्दी"). The table is the
    source of truth and already carries every shipped locale, so this needs no
    per-language maintenance. Falls back to the primary subtag, else None.

    Matched case-INSENSITIVELY: clients spell the script subtag inconsistently
    (`sr-cyrl` vs the table's canonical `sr-Cyrl`), and a case-sensitive miss
    returns None → the `Language:` directive falls back to a bare locale code,
    which makes the planner/intro writer drift to Russian. Normalising both
    sides removes that failure mode without a per-locale hardcode."""
    try:
        with _catalog_conn(db_path) as conn:
            rows = conn.execute("SELECT code, full_name FROM languages").fetchall()
    except sqlite3.Error:
        return None
    by_code = {r["code"].lower(): r["full_name"] for r in rows if r["full_name"]}
    c = (code or "").lower()
    return by_code.get(c) or by_code.get(c.split("-")[0])


def _resolve_sync(
    db_path: Path,
    kind: ResolveKind,
    text: str,
    lang: str | None,
    limit: int,
) -> list[ResolvedEntity]:
    table, extra_fields = _RESOLVE_TABLES[kind]
    rows = _load_dict(db_path, table, lang, extra_fields)
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

def _collection_track_ids(
    conn: sqlite3.Connection, collection_id: str, language: str,
) -> tuple[str, ...]:
    rows = conn.execute(
        """
        SELECT track_id FROM collection_tracks
        WHERE collection_id = ? AND collection_language = ?
        ORDER BY position ASC, track_id ASC
        """,
        (collection_id, language),
    ).fetchall()
    return tuple(r[0] for r in rows)


def _search_collections_sync(
    db_path: Path, query: str | None, lang: str | None, limit: int,
) -> list[Collection]:
    """Find collections by name. With no query, returns the featured set.
    Per-locale: filters to `lang` when given. Returns [] when the catalog
    predates the schema.

    Name matching is done in Python with `casefold()` substring rather than SQL
    `LIKE COLLATE NOCASE`, which only folds ASCII — a Russian query like «ишоп»
    would never match the title «Ишопанишад». The collection corpus is small
    enough that fetching the locale's rows and filtering in Python is cheap.
    """
    needle = (query or "").strip().casefold()
    try:
        with _catalog_conn(db_path) as conn:
            sql = (
                "SELECT id, language, name, COALESCE(cover, ''), COALESCE(description, '') "
                "FROM collections WHERE 1 = 1"
            )
            params: list[Any] = []
            if lang:
                sql += " AND language = ?"
                params.append(lang)
            if not needle:
                sql += (
                    " AND EXISTS (SELECT 1 FROM collection_tags ct "
                    "WHERE ct.collection_id = collections.id "
                    "AND ct.collection_language = collections.language "
                    "AND ct.tag_id = 'tag_featured')"
                )
            sql += " ORDER BY sort_order ASC, id ASC"
            rows = conn.execute(sql, params).fetchall()
            out: list[Collection] = []
            for r in rows:
                if needle and needle not in (r[2] or "").casefold():
                    continue
                cid, clang = r[0], r[1]
                out.append(Collection(
                    id=cid, name=r[2], cover=r[3], description=r[4],
                    track_ids=_collection_track_ids(conn, cid, clang),
                ))
                if len(out) >= limit:
                    break
            return out
    except sqlite3.OperationalError:
        return []  # collections / collection_tags absent on an older catalog


def _get_collection_sync(
    db_path: Path, collection_id: str, lang: str | None,
) -> Collection | None:
    try:
        with _catalog_conn(db_path) as conn:
            sql = (
                "SELECT id, language, name, COALESCE(cover, ''), COALESCE(description, '') "
                "FROM collections WHERE id = ?"
            )
            params: list[Any] = [collection_id]
            if lang:
                sql += " AND language = ?"
                params.append(lang)
            sql += (
                " ORDER BY CASE language WHEN ? THEN 0 WHEN 'en' THEN 1 ELSE 2 END LIMIT 1"
            )
            params.append(lang or "en")
            row = conn.execute(sql, params).fetchone()
            if row is None:
                return None
            cid, clang = row[0], row[1]
            return Collection(
                id=cid, name=row[2], cover=row[3], description=row[4],
                track_ids=_collection_track_ids(conn, cid, clang),
            )
    except sqlite3.OperationalError:
        return None


def _get_outline_sync(
    db_path: Path, track_id: str, lang: str,
) -> tuple[str | None, str | None]:
    """Read the precomputed outline JSON + description for one (track,
    language) from the published catalog. Returns (None, None) when absent or
    when an older snapshot predates the columns (transition window)."""
    with _catalog_conn(db_path) as conn:
        try:
            row = conn.execute(
                "SELECT outline, description FROM track_variants "
                "WHERE track_id = ? AND language = ?",
                (track_id, lang),
            ).fetchone()
        except sqlite3.OperationalError:
            return None, None
    if row is None:
        return None, None
    return row["outline"], row["description"]


class SqliteCatalogRepository:
    def __init__(self, *, catalog_db_path: Path) -> None:
        self._db_path = catalog_db_path

    async def search_collections(
        self, query: str | None, *, lang: str | None, limit: int = 10,
    ) -> list[Collection]:
        return await asyncio.to_thread(
            _search_collections_sync, self._db_path, query, lang, limit,
        )

    async def get_collection(
        self, collection_id: str, *, lang: str | None = None,
    ) -> Collection | None:
        return await asyncio.to_thread(
            _get_collection_sync, self._db_path, collection_id, lang,
        )

    async def get_track(self, track_id: str, *, lang: str) -> Track | None:
        return await asyncio.to_thread(
            _get_track_sync, self._db_path, track_id, lang,
        )

    async def get_titles(
        self, track_ids: list[str], *, lang: str | None = None,
    ) -> dict[str, str]:
        return await asyncio.to_thread(
            _get_titles_sync, self._db_path, track_ids, lang,
        )

    async def filter_existing_track_ids(self, track_ids: list[str]) -> list[str]:
        return await asyncio.to_thread(
            _filter_existing_track_ids_sync, self._db_path, track_ids,
        )

    async def topic_weights_for_tracks(
        self, track_ids: list[str],
    ) -> list[tuple[str, str, float]]:
        return await asyncio.to_thread(
            _topic_weights_for_tracks_sync, self._db_path, track_ids,
        )

    async def top_track_ids_for_topic(
        self, topic_id: str, *, languages: list[str], limit: int,
    ) -> list[str]:
        return await asyncio.to_thread(
            _top_track_ids_for_topic_sync, self._db_path, topic_id, languages, limit,
        )

    async def topic_names(
        self, topic_ids: list[str], *, lang: str,
    ) -> dict[str, str]:
        return await asyncio.to_thread(
            _topic_names_sync, self._db_path, topic_ids, lang,
        )

    async def get_outline(
        self, track_id: str, lang: str,
    ) -> tuple[str | None, str | None]:
        return await asyncio.to_thread(
            _get_outline_sync, self._db_path, track_id, lang,
        )

    async def resolve_transcript_path(
        self, track_id: str, *, requested_lang: str,
    ) -> tuple[str | None, str]:
        return await asyncio.to_thread(
            _resolve_transcript_path_sync, self._db_path, track_id, requested_lang,
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
        ref_prefix: str | None = None,
        ref_from: int | None = None,
        ref_to: int | None = None,
    ) -> list[Track]:
        return await asyncio.to_thread(
            _list_tracks_sync,
            self._db_path,
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
            ref_prefix=ref_prefix,
            ref_from=ref_from,
            ref_to=ref_to,
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
            self._db_path,
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
        return await asyncio.to_thread(
            _resolve_sync, self._db_path, kind, text, lang, limit,
        )

    async def get_author_names(
        self,
        author_ids: list[str],
        *,
        lang: str,
    ) -> dict[str, str]:
        if not author_ids:
            return {}
        return await asyncio.to_thread(
            _get_author_names_sync, self._db_path, author_ids, lang,
        )

    async def source_short_label(self, source_id: str, *, lang: str) -> str | None:
        return await asyncio.to_thread(
            _source_short_label_sync, self._db_path, source_id, lang,
        )

    async def language_name(self, code: str) -> str | None:
        return await asyncio.to_thread(_language_name_sync, self._db_path, code)

    def invalidate_cache(self) -> None:
        invalidate_dict_cache()
