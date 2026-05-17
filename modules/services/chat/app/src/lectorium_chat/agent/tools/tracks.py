"""get_track — full metadata for one track id."""

from __future__ import annotations

import asyncio
from typing import Any

from lectorium_chat.agent.tools._sqlite import catalog_conn


def _get_track_sync(track_id: str, lang: str) -> dict[str, Any] | None:
    with catalog_conn() as conn:
        track = conn.execute(
            "SELECT id, author_id, location_id, date, hidden FROM tracks WHERE id = ?",
            (track_id,),
        ).fetchone()
        if track is None or track["hidden"] == 1:
            return None

        # Title from preferred lang, fallback to any variant
        variant = conn.execute(
            """
            SELECT title, language, audio_duration FROM track_variants
            WHERE track_id = ?
            ORDER BY CASE language WHEN ? THEN 0 WHEN 'en' THEN 1 ELSE 2 END
            LIMIT 1
            """,
            (track_id, lang),
        ).fetchone()
        languages = [
            r["language"] for r in conn.execute(
                "SELECT language FROM track_variants WHERE track_id = ?",
                (track_id,),
            ).fetchall()
        ]

        # Author / location names in requested lang
        author = None
        if track["author_id"]:
            row = conn.execute(
                "SELECT full_name FROM authors WHERE id = ? AND language = ?",
                (track["author_id"], lang),
            ).fetchone()
            author = {"id": track["author_id"],
                     "name": row["full_name"] if row else track["author_id"]}
        location = None
        if track["location_id"]:
            row = conn.execute(
                "SELECT full_name FROM locations WHERE id = ? AND language = ?",
                (track["location_id"], lang),
            ).fetchone()
            location = {"id": track["location_id"],
                       "name": row["full_name"] if row else track["location_id"]}

        # Tags
        tag_rows = conn.execute(
            """
            SELECT tt.tag_id, tg.full_name
            FROM track_tags tt
            LEFT JOIN tags tg ON tg.id = tt.tag_id AND tg.language = ?
            WHERE tt.track_id = ?
            """,
            (lang, track_id),
        ).fetchall()

        # References
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

        return {
            "track_id": track_id,
            "title": variant["title"] if variant else None,
            "date": track["date"],
            "author": author,
            "location": location,
            "tag_ids": [r["tag_id"] for r in tag_rows],
            "tag_names": [r["full_name"] or r["tag_id"] for r in tag_rows],
            "duration_ms": variant["audio_duration"] if variant else None,
            "languages": languages,
            "references": [
                {"source_id": r["source_id"], "full_name": r["full_name"],
                 "short_name": r["short_name"], "tokens": r["tokens"]}
                for r in ref_rows
            ],
        }


async def get_track(track_id: str, lang: str = "ru") -> dict[str, Any] | None:
    return await asyncio.to_thread(_get_track_sync, track_id, lang)


TOOL_REGISTRY = [
    {
        "name": "get_track",
        "fn": get_track,
        "personalized": False,
        "description": "Fetch full metadata for one track by id. Use to enrich a citation.",
        "parameters": {
            "type": "object",
            "properties": {
                "track_id": {"type": "string"},
                "lang": {"type": "string", "default": "ru"},
            },
            "required": ["track_id"],
        },
    },
]
