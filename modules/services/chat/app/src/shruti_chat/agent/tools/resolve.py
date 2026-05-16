"""resolve_{author,source,location,tag} — fuzzy dictionary lookup.

Mirrors the LLM-fuzzy pattern from `shruti-mcp` review/resolver: returns
top-N candidates ranked by token-set similarity, the agent picks the right
one. Uses rapidfuzz for Unicode-aware, case-insensitive, typo-tolerant
matching (SQLite's `LOWER()` + `LIKE` doesn't handle Cyrillic case).

Dict tables are small (~thousands of rows) so we load them in memory and
cache by `(table, lang)` until the catalog DB swaps; on swap we just keep
serving the previous cache and refresh on the next miss.
"""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from typing import Any

from rapidfuzz import fuzz, process, utils

from shruti_chat.agent.tools._sqlite import catalog_conn


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

    with catalog_conn() as conn:
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


def invalidate_dict_cache() -> None:
    """Call from catalog.ensure_catalog() after a swap."""
    with _lock:
        _cache.clear()


def _fuzzy_top(
    query: str,
    rows: list[_DictRow],
    limit: int = 8,
) -> list[tuple[_DictRow, float]]:
    """Return up to `limit` candidates with score in 0..1 (cosine-friendly)."""
    if not rows or not query.strip():
        return []
    # token_set_ratio is robust to word order, repeated/extra words, and
    # honorifics. processor=utils.default_process casefolds + strips
    # punctuation/diacritics — works across cyrillic + diacritic-heavy
    # Sanskrit transliteration.
    matches = process.extract(
        query,
        {r.id: r.full_name for r in rows},
        scorer=fuzz.token_set_ratio,
        processor=utils.default_process,
        limit=limit,
        score_cutoff=40,   # below 40 it's noise
    )
    by_id = {r.id: r for r in rows}
    return [(by_id[mid], score / 100.0) for (_name, score, mid) in matches]


def _resolve_sync(
    table: str,
    text: str,
    lang: str | None,
    extra_fields: list[str] | None = None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    extra = extra_fields or []
    rows = _load_dict(table, lang, extra)
    out: list[dict[str, Any]] = []
    for row, score in _fuzzy_top(text, rows, limit):
        d: dict[str, Any] = {"full_name": row.full_name, "confidence": round(score, 3)}
        d.update(row.extra)
        out.append((row.id, d))  # type: ignore[arg-type]
    # Caller renames `id` into the right key.
    return out  # type: ignore[return-value]


async def resolve_author(text: str, lang: str | None = None) -> list[dict[str, Any]]:
    raw = await asyncio.to_thread(_resolve_sync, "authors", text, lang)
    return [{"author_id": rid, **payload} for (rid, payload) in raw]


async def resolve_source(text: str, lang: str | None = None) -> list[dict[str, Any]]:
    raw = await asyncio.to_thread(_resolve_sync, "sources", text, lang, ["short_name"])
    return [{"source_id": rid, **payload} for (rid, payload) in raw]


async def resolve_location(text: str, lang: str | None = None) -> list[dict[str, Any]]:
    raw = await asyncio.to_thread(_resolve_sync, "locations", text, lang)
    return [{"location_id": rid, **payload} for (rid, payload) in raw]


async def resolve_tag(text: str, lang: str | None = None) -> list[dict[str, Any]]:
    raw = await asyncio.to_thread(_resolve_sync, "tags", text, lang)
    return [{"tag_id": rid, **payload} for (rid, payload) in raw]
