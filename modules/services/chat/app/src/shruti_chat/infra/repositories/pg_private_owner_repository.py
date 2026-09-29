"""Postgres reads and writes of the private lane's owner records (`chunk_meta`).

`chunk_meta` is the ACL for the private per-user lecture lane — one row per
(owner, track), keyed on the verified JWT `sub` — plus the speaker each upload
was indexed with. Every read here degrades to empty when the table is absent.
"""

from __future__ import annotations

import asyncpg

from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


class PgPrivateOwnerRepository:
    def __init__(self, *, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def purge_owner(self, user_id: str) -> dict[str, int]:
        """Erase what a deleted account left in the private lane.

        Two steps, one transaction: drop that owner's `chunk_meta` rows, then
        the `user_track` chunks of any track nobody owns any more (embeddings
        go with them — `ON DELETE CASCADE`, migration 0030). A track shared by
        two people keeps its chunks; only the departing owner's row goes, which
        is exactly what the owner-per-row shape is for.
        """
        if not user_id:
            return {"meta_rows": 0, "chunks": 0}
        async with self._pool.acquire() as conn, conn.transaction():
            meta = await conn.fetch(
                "DELETE FROM chunk_meta WHERE owner_id = $1 RETURNING track_id",
                user_id,
            )
            track_ids = sorted({r["track_id"] for r in meta})
            chunks = 0
            if track_ids:
                chunks = await conn.fetchval(
                    """
                    WITH gone AS (
                        DELETE FROM chunks
                         WHERE kind = 'user_track'
                           AND track_id = ANY($1::text[])
                           AND NOT EXISTS (
                               SELECT 1 FROM chunk_meta cm
                                WHERE cm.track_id = chunks.track_id
                           )
                        RETURNING 1
                    )
                    SELECT count(*) FROM gone
                    """,
                    track_ids,
                )
        log.info(
            "private_library_purged",
            user_id=user_id,
            meta_rows=len(meta),
            chunks=chunks or 0,
        )
        return {"meta_rows": len(meta), "chunks": int(chunks or 0)}

    async def get_owned_track_ids(self, user_id: str) -> list[str]:
        """Track ids the given user (JWT `sub`) may retrieve in the private
        lane — read from the server-side `owned` projection (migration 0044).

        This is the SOLE ACL source for the private lane: it is keyed on the
        verified `sub`, never on client-supplied `recent_tracks`, so a client
        cannot widen its own access. Returns an empty list for an anonymous /
        unknown user or when the projection has no rows for them. Best-effort:
        a missing `chunk_meta` table (migration not yet applied) yields [] rather
        than failing the turn, matching the feature's graceful-degradation
        contract."""
        if not user_id:
            return []
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT track_id FROM chunk_meta WHERE owner_id = $1",
                    user_id,
                )
        except asyncpg.UndefinedTableError:
            return []
        return [r["track_id"] for r in rows]

    async def get_owned_track_ids_by_author(
        self, user_id: str, author_ids: list[str], author_raws: list[str] | None = None,
    ) -> list[str]:
        """The subset of this user's own tracks spoken by one of `author_ids`.

        One indexed read on the primary key's leading column — the speaker was
        resolved when the track was indexed and stored beside the ACL, so the
        private lane's whole question ("what may they read, and is it the right
        teacher") is answered by a single row scan with no join.

        `author_raws` are the names as this person's own uploads recorded them —
        matched exactly, because the caller already decided WHICH stored spellings
        the asked-for name denotes (see `lecture_authors`, which compares across
        scripts and honorifics over the few names one library holds). That is what
        makes a teacher the corpus never heard of selectable at all.

        A track with neither a resolved author nor a matching name is NOT
        returned: under a lecturer filter, a recording we cannot attribute is not
        known to be by the person who was asked for.
        `unattributed_owned_count` is how a caller tells the person those exist.
        """
        raws = list(author_raws or [])
        if not user_id or (not author_ids and not raws):
            return []
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT track_id FROM chunk_meta
                     WHERE owner_id = $1
                       AND (author_id = ANY($2::text[])
                            OR author_raw = ANY($3::text[]))
                    """,
                    user_id, list(author_ids), raws,
                )
        except asyncpg.UndefinedTableError:
            return []
        return [r["track_id"] for r in rows]

    async def get_own_author_names(self, user_id: str) -> list[str]:
        """Distinct speaker names across this person's own uploads.

        A handful of strings — a library holds tens of recordings, not thousands —
        which is what makes it affordable to compare an asked-for name against all
        of them in code, across scripts and honorifics.
        """
        if not user_id:
            return []
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT DISTINCT author_raw FROM chunk_meta
                     WHERE owner_id = $1 AND author_raw IS NOT NULL
                    """,
                    user_id,
                )
        except asyncpg.UndefinedTableError:
            return []
        return [r["author_raw"] for r in rows if (r["author_raw"] or "").strip()]

    async def owned_langs_for_authors(
        self, user_id: str, author_ids: list[str], author_raws: list[str],
    ) -> list[str]:
        """Languages of this person's own recordings by the given lecturers.

        Only useful to say out loud: when their recordings exist but in another
        language, "nothing found" is the wrong answer and "they are in English" is
        the right one.
        """
        raws = list(author_raws or [])
        if not user_id or (not author_ids and not raws):
            return []
        try:
            async with self._pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT DISTINCT c.lang
                      FROM chunk_meta m
                      JOIN chunks c
                        ON c.track_id = m.track_id AND c.kind = 'user_track'
                     WHERE m.owner_id = $1
                       AND (m.author_id = ANY($2::text[])
                            OR m.author_raw = ANY($3::text[]))
                    """,
                    user_id, list(author_ids), raws,
                )
        except asyncpg.UndefinedTableError:
            return []
        return [r["lang"] for r in rows if r["lang"]]

    async def unattributed_owned_count(self, user_id: str) -> int:
        """How many of this user's own tracks say nothing about who is speaking.

        A recording whose speaker the CATALOG does not know is still selectable by
        the name the ingest heard, so it does not count here — only one with
        neither. Those fall out of every lecturer-filtered answer, and the person
        cannot see why unless told.
        """
        if not user_id:
            return 0
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT count(*) AS n FROM chunk_meta
                     WHERE owner_id = $1
                       AND author_id IS NULL AND author_raw IS NULL
                    """,
                    user_id,
                )
        except asyncpg.UndefinedTableError:
            return 0
        return int((row or {}).get("n") or 0)
