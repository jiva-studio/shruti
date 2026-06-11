"""Postgres-backed persistent cache for MT-translated citations.

One row per (content_hash, language, model, prompt_version). The hash is
blake2b-12 hex of the SOURCE text (same digest the embedding / key
helpers use — NOT sha256 hash_body). Translating once benefits every
user; the row survives model/prompt rotation because both are in the PK,
so a model swap mints fresh rows and leaves the old ones to age (or be
re-warmed) without a destructive migration.
"""

from __future__ import annotations

import hashlib

import asyncpg


def content_hash(text: str) -> str:
    """blake2b-12 hex of the source text — the stable cache id. Matches the
    digest scheme used by `cache_helpers.make_key` / `_embedding_digest`."""
    return hashlib.blake2b(text.encode("utf-8"), digest_size=12).hexdigest()


class PgTranslationCache:
    def __init__(self, *, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def get(
        self,
        *,
        source_text: str,
        language: str,
        model: str,
        prompt_version: str,
    ) -> str | None:
        """Return the cached translation, or None on miss."""
        ch = content_hash(source_text)
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT translated_text FROM chunk_translations
                 WHERE content_hash = $1 AND language = $2
                   AND model = $3 AND prompt_version = $4
                """,
                ch, language, model, prompt_version,
            )
        return row["translated_text"] if row is not None else None

    async def put(
        self,
        *,
        source_text: str,
        language: str,
        model: str,
        prompt_version: str,
        translated_text: str,
    ) -> None:
        """Insert a translation. ON CONFLICT DO NOTHING — a concurrent turn
        may have written the same row first; the first writer wins and we
        never overwrite (the value is deterministic for the key anyway)."""
        ch = content_hash(source_text)
        async with self._pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO chunk_translations
                    (content_hash, language, model, prompt_version, translated_text)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (content_hash, language, model, prompt_version)
                DO NOTHING
                """,
                ch, language, model, prompt_version, translated_text,
            )
