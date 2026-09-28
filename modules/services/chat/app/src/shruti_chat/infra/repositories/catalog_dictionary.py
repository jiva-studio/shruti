"""The resolve dictionary: authors, sources, locations and tags, fuzzy-matched.

The same rows are consumed by every `resolve` call across requests, so they
are cached per process. Entries are keyed by the file's stat signature, so a
swapped catalog is a cache miss; `invalidate_dict_cache` only releases memory.
"""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rapidfuzz import fuzz, process, utils

from shruti_chat.domain.entities import ResolvedEntity
from shruti_chat.domain.ports.catalog_repository import ResolveKind
from shruti_chat.infra.repositories.sqlite_mirror import catalog_conn, stat_signature


@dataclass(frozen=True)
class _CacheKey:
    """Identifies one dictionary load down to the exact file it came from.

    `signature` is the `stat_signature` of `db_path` taken before the read,
    so a file swapped in by the indexer (new inode) is a new key and can
    never be answered from the rows of the one it replaced.
    """

    db_path: str
    signature: tuple[int, int, int]
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
    """Drop every cached dictionary. Called by the indexer after a catalog
    swap to release the old file's rows; correctness does not depend on it,
    because the key carries the file's stat signature."""
    with _lock:
        _cache.clear()


_RESOLVE_TABLES = {
    "author":   ("authors",   []),
    "source":   ("sources",   ["short_name"]),
    "location": ("locations", []),
    "tag":      ("tags",      []),
}


def normalize_source_id(
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
        with catalog_conn(db_path) as conn:
            rows = conn.execute("SELECT id, short_name FROM sources").fetchall()
    except sqlite3.Error:
        return None
    for r in rows:
        sn = r["short_name"] or ""
        if sn.strip().casefold() == needle:
            return r["id"]
    return None


def load_dict(
    db_path: Path,
    table: str,
    lang: str | None,
    extra_fields: list[str],
) -> list[_DictRow]:
    signature = stat_signature(db_path)
    key = _CacheKey(str(db_path), signature, table, lang) if signature else None
    if key is not None:
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
    with catalog_conn(db_path) as conn:
        rows = conn.execute(sql, params).fetchall()
    out = [
        _DictRow(
            id=r["id"],
            full_name=r["full_name"],
            extra={c: r[c] for c in extra_fields},
        )
        for r in rows
    ]
    # A load that raced a swap files its rows under the signature it started
    # with, which no later call computes again; entries for any other
    # signature of this path belong to replaced files and are dropped.
    if key is not None:
        with _lock:
            for stale in [
                k for k in _cache if k.db_path == key.db_path and k.signature != signature
            ]:
                del _cache[stale]
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
    owners: list[int] = []
    for i, r in enumerate(rows):
        choices.append(r.full_name)
        owners.append(i)
        short = r.extra.get("short_name")
        if short:
            choices.append(short)
            owners.append(i)
    matches = process.extract(
        query,
        choices,
        scorer=fuzz.token_set_ratio,
        processor=utils.default_process,
        limit=limit * 2,
        score_cutoff=40,
    )
    # Keep the ROW whose name actually matched, not just its id. With
    # `lang=None` the pool holds one row per locale for the same entity, so
    # picking a row by id alone hands back an arbitrary locale's name — the
    # query matches "A. C. Bhaktivedanta Swami Prabhupada" and the caller
    # receives «А. Ч. Бхактиведанта Свами Прабхупада», which no cross-script
    # comparison can then recognise as the same person.
    best: dict[str, tuple[float, _DictRow]] = {}
    for (_text, score, idx) in matches:
        row = rows[owners[idx]]
        previous = best.get(row.id)
        if previous is None or score > previous[0]:
            best[row.id] = (score, row)
    ranked = sorted(best.values(), key=lambda sr: -sr[0])[:limit]
    return [(row, score / 100.0) for score, row in ranked]


def resolve_entities_sync(
    db_path: Path,
    kind: ResolveKind,
    text: str,
    lang: str | None,
    limit: int,
) -> list[ResolvedEntity]:
    table, extra_fields = _RESOLVE_TABLES[kind]
    rows = load_dict(db_path, table, lang, extra_fields)
    return [
        ResolvedEntity(
            id=row.id,
            full_name=row.full_name,
            confidence=round(score, 3),
            extra=dict(row.extra),
        )
        for row, score in _fuzzy_top(text, rows, limit)
    ]
