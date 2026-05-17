"""list_tracks — deterministic metadata filter over the catalog.

Returns track cards suitable for [card:track_id] rendering: title (per lang
with fallback), date, author, location, duration, tags, references.
"""

from __future__ import annotations

import asyncio
from typing import Any

from shruti_chat.agent.tools._fts import matches as _title_matches, tokens as _title_tokens
from shruti_chat.agent.tools._sqlite import catalog_conn


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
) -> list[dict[str, Any]]:
    # When lang is None, fall back to "ru" for the title lookup join, but
    # skip the EXISTS-filter so all languages remain visible.
    title_lang = lang or "en"
    with catalog_conn() as conn:
        # Main row: tracks JOIN track_variants on requested lang (LEFT — fallback later)
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
        # Filter: only return tracks that have a transcript in the requested
        # language. Without this the agent surfaces English-only tracks to
        # Russian users (and vice-versa) — citations are then empty because
        # there are no chunks in their language. To override (e.g. user asks
        # to broaden), the agent passes lang=null.
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
                # In-memory fold + prefix match over all track_variants
                # titles. Catalog is small (~10-20K variant rows) so this
                # is microseconds; FTS4's `remove_diacritics=2` would skip
                # Cyrillic ё/й folding and break ё↔е symmetry, so we don't
                # use it.
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

        # Fallback titles for tracks missing the requested lang variant
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
                fallback_titles.setdefault(r["track_id"],
                                            (r["title"], r["language"], r["audio_duration"]))

        # Dict lookups: author + location names (in requested lang)
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
                (r["tag_id"], r["full_name"] or r["tag_id"]))

        # References per track
        track_refs: dict[str, list[dict[str, Any]]] = {}
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
            track_refs.setdefault(r["track_id"], []).append({
                "source_id": r["source_id"],
                "short_name": r["short_name"],
                "full_name": r["full_name"],
                "tokens": r["tokens"],
            })

        out: list[dict[str, Any]] = []
        for r in rows:
            tid = r["track_id"]
            title = r["title_req"]
            actual_lang = r["lang_actual"] or title_lang
            duration = r["duration_ms"]
            if title is None and tid in fallback_titles:
                title, actual_lang, duration = fallback_titles[tid]
            tags = track_tags.get(tid, [])
            out.append({
                "track_id": tid,
                "title": title or "(untitled)",
                "lang": actual_lang,
                "date": r["date"],
                "author_id": r["author_id"],
                "author_name": author_names.get(r["author_id"]) if r["author_id"] else None,
                "location_id": r["location_id"],
                "location_name": location_names.get(r["location_id"]) if r["location_id"] else None,
                "tag_ids": [t[0] for t in tags],
                "tag_names": [t[1] for t in tags],
                "duration_ms": duration,
                "references": track_refs.get(tid, []),
            })
        return out


async def list_tracks(
    author_id: str | None = None,
    source_id: str | None = None,
    location_id: str | None = None,
    tag_ids: list[str] | None = None,
    title_query: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    lang: str | None = "ru",
    limit: int = 20,
    offset: int = 0,
) -> list[dict[str, Any]]:
    return await asyncio.to_thread(
        _list_tracks_sync,
        author_id=author_id, source_id=source_id, location_id=location_id,
        tag_ids=tag_ids, title_query=title_query,
        date_from=date_from, date_to=date_to,
        lang=lang, limit=limit, offset=offset,
    )


TOOL_REGISTRY = [
    {
        "name": "list_tracks",
        "fn": list_tracks,
        "personalized": False,
        "description": (
            "Deterministic metadata filter over the lecture catalog. Use "
            "for list-style queries: 'lectures by X from Y in period Z'. "
            "Returns tracks for [card:track_id] markers in your reply. "
            "Kind (morning walk / conversation / lecture / ...) is "
            "passed via tag_ids (e.g. ['tag_morning_walk']).\n\n"
            "**`title_query` is the way to find a lecture by name.** "
            "When the user says «найди лекцию «X»» / «перескажи лекцию X», "
            "pass the bare phrase (no quotes) as `title_query` — it runs "
            "FTS against the actual lecture titles (with prefix matching, "
            "accent-insensitive). search_transcripts searches the SPOKEN "
            "TEXT, not titles — don't use it for 'find lecture named X'."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "author_id": {"type": "string"},
                "source_id": {"type": "string"},
                "location_id": {"type": "string"},
                "tag_ids": {"type": "array", "items": {"type": "string"}},
                "title_query": {
                    "type": "string",
                    "description": "Fuzzy FTS query over track titles. Use for «найди лекцию X».",
                },
                "date_from": {"type": "string"},
                "date_to": {"type": "string"},
                "lang": {"type": "string", "enum": ["ru", "en"], "default": "ru"},
                "limit": {"type": "integer", "default": 20},
                "offset": {"type": "integer", "default": 0},
            },
        },
    },
]
