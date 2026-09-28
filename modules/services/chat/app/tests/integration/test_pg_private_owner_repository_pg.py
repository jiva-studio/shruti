"""`PgPrivateOwnerRepository`'s SQL, run by Postgres against `chunk_meta`.

Rows are written under owner ids and track ids no real user has, and removed
afterwards. Marked `needs_db`.
"""

from __future__ import annotations

import asyncpg
import pytest

from shruti_chat.infra.repositories.pg_private_owner_repository import (
    PgPrivateOwnerRepository,
)

pytestmark = pytest.mark.needs_db

_ME = "itest-owner-me"
_OTHER = "itest-owner-other"
_OWNERS = [_ME, _OTHER]

# owner, track, author_id, author_raw
_META = [
    (_ME, "itest-t-catalog", "acbsp", "Srila Prabhupada"),
    (_ME, "itest-t-raw-only", None, "Rohini Suta Prabhu"),
    (_ME, "itest-t-anon", None, None),
    (_ME, "itest-t-blank", None, " "),
    (_ME, "itest-t-shared", "hh-ns", "Niranjana Swami"),
    (_OTHER, "itest-t-shared", "hh-ns", "Niranjana Swami"),
    (_OTHER, "itest-t-theirs", "acbsp", "Srila Prabhupada"),
]
# track, lang
_USER_CHUNKS = [
    ("itest-t-catalog", "en"),
    ("itest-t-raw-only", "ru"),
    ("itest-t-shared", "ru"),
    ("itest-t-anon", "en"),
]
_TRACKS = sorted({m[1] for m in _META})


@pytest.fixture
async def repo(chat_schema_url: str):
    pool = await asyncpg.create_pool(chat_schema_url, min_size=1, max_size=2)
    async with pool.acquire() as conn:
        await _clean(conn)
        await conn.executemany(
            "INSERT INTO chunk_meta (owner_id, track_id, author_id, author_raw)"
            " VALUES ($1, $2, $3, $4)",
            _META,
        )
        await conn.executemany(
            "INSERT INTO chunks (kind, track_id, lang, text, embed_model, start_ms, end_ms)"
            " VALUES ('user_track', $1, $2, 'x', 'itest-model', 0, 1000)",
            _USER_CHUNKS,
        )
        # A public transcript of a track I own must not count as my recording.
        await conn.execute(
            "INSERT INTO chunks (kind, track_id, lang, text, embed_model)"
            " VALUES ('track_transcript', 'itest-t-catalog', 'sr', 'x', 'itest-model')",
        )
    yield PgPrivateOwnerRepository(pool=pool)
    async with pool.acquire() as conn:
        await _clean(conn)
    await pool.close()


async def _clean(conn) -> None:
    await conn.execute("DELETE FROM chunk_meta WHERE owner_id = ANY($1::text[])", _OWNERS)
    await conn.execute("DELETE FROM chunks WHERE track_id = ANY($1::text[])", _TRACKS)


async def test_owned_tracks_are_mine_only(repo) -> None:
    assert sorted(await repo.get_owned_track_ids(_ME)) == [
        "itest-t-anon", "itest-t-blank", "itest-t-catalog", "itest-t-raw-only",
        "itest-t-shared",
    ]
    assert await repo.get_owned_track_ids("itest-nobody") == []


async def test_owned_tracks_by_author_match_the_id_or_the_recorded_name(repo) -> None:
    by_id = await repo.get_owned_track_ids_by_author(_ME, ["acbsp"])
    assert by_id == ["itest-t-catalog"]
    by_raw = await repo.get_owned_track_ids_by_author(_ME, [], ["Rohini Suta Prabhu"])
    assert by_raw == ["itest-t-raw-only"]
    both = await repo.get_owned_track_ids_by_author(_ME, ["hh-ns"], ["Rohini Suta Prabhu"])
    assert sorted(both) == ["itest-t-raw-only", "itest-t-shared"]


async def test_own_author_names_are_distinct_and_skip_blanks(repo) -> None:
    assert sorted(await repo.get_own_author_names(_ME)) == [
        "Niranjana Swami", "Rohini Suta Prabhu", "Srila Prabhupada",
    ]


async def test_owned_languages_come_from_my_recordings_only(repo) -> None:
    langs = await repo.owned_langs_for_authors(_ME, ["acbsp", "hh-ns"], [])
    assert sorted(langs) == ["en", "ru"]  # not the public transcript's "sr"


async def test_unattributed_count_is_tracks_with_neither_id_nor_name(repo) -> None:
    # " " is a recorded name, so only the fully anonymous track counts.
    assert await repo.unattributed_owned_count(_ME) == 1
    assert await repo.unattributed_owned_count("itest-nobody") == 0


async def test_purge_keeps_a_track_another_owner_still_has(repo) -> None:
    got = await repo.purge_owner(_ME)
    assert got == {"meta_rows": 5, "chunks": 3}
    assert await repo.get_owned_track_ids(_ME) == []
    assert sorted(await repo.get_owned_track_ids(_OTHER)) == ["itest-t-shared", "itest-t-theirs"]
    assert await repo.owned_langs_for_authors(_OTHER, ["hh-ns"], []) == ["ru"]
