"""«Nothing this week» and «you have no history» are different answers.

On 2026-08-06 one person asked three questions in five minutes:

    04:05  What I heard this week      → "I didn't find any recorded lectures
                                          in your history for this week"
    04:09  Where did I stop?           → "I didn't find any record of your
                                          recent activity"
    04:10  Start Any lecture           → "I am suggesting lectures on the
                                          topics you have recently been
                                          exploring"

They had exactly one track in their history: played, finished, and older than
the week they asked about. Every windowed lookup came back `[]`, the model read
that as "this person has never listened to anything", and the recommender —
working off the very same track — said the opposite five minutes later.

An empty list cannot tell those two situations apart, so it stops being the
answer: when the window is empty but a history exists, the tool says so and
hands over when the last listen was.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from lectorium_chat.agent.tools.user_tracks_list import user_tracks_list
from lectorium_chat.domain.user_context import UserContext, UserContextTrack


_NOW = datetime(2026, 8, 6, 9, 39, tzinfo=UTC)
_LAST_MONTH = _NOW - timedelta(days=34)


class _Catalog:
    def __init__(self, live: set[str] | None = None) -> None:
        self._live = live

    async def filter_existing_track_ids(self, ids):
        return [i for i in ids if self._live is None or i in self._live]


class _Aliases:
    def alias_track(self, track_id: str) -> int:
        return 1


def _ctx(*tracks: UserContextTrack) -> UserContext:
    return UserContext(user_id="u-1", now=_NOW, recent_tracks=tuple(tracks))


def _track(tid: str, *, played: datetime | None, percent: float = 1.0):
    return UserContextTrack(
        track_id=tid, position_ms=1000, percent=percent, last_played_at=played,
    )


async def _call(ctx: UserContext, **kw: Any):
    return await user_tracks_list(
        user_context=ctx, catalog_repo=_Catalog(), alias_map=_Aliases(), **kw,
    )


async def test_an_empty_week_still_admits_the_history() -> None:
    got = await _call(
        _ctx(_track("t1", played=_LAST_MONTH)),
        since=(_NOW - timedelta(days=6)).isoformat(),
        until=_NOW.isoformat(),
    )
    assert got["history_exists"] is True
    assert got["tracks"] == []
    assert got["last_played_at"].startswith("2026-07-03")
    assert "no history" in got["hint"]


async def test_nothing_in_progress_is_not_nothing_at_all() -> None:
    """«Where did I stop?» asks for an unfinished track. Having finished
    everything is not the same as never having started."""
    got = await _call(_ctx(_track("t1", played=_LAST_MONTH, percent=1.0)),
                      status="in_progress")
    assert got["history_exists"] is True


async def test_a_person_who_never_listened_gets_a_plain_empty() -> None:
    assert await _call(_ctx()) == []


async def test_history_with_no_timestamps_reads_as_nothing_to_date() -> None:
    # Nothing to say "the last listen was …" about, so the honest answer is
    # the plain empty one rather than an invented date.
    got = await _call(
        _ctx(_track("t1", played=None)),
        since=(_NOW - timedelta(days=6)).isoformat(),
    )
    assert got == []


async def test_a_window_with_matches_answers_with_them() -> None:
    got = await _call(
        _ctx(_track("t1", played=_NOW - timedelta(days=1))),
        since=(_NOW - timedelta(days=6)).isoformat(),
        until=_NOW.isoformat(),
    )
    assert isinstance(got, list) and len(got) == 1
    assert got[0]["track_ref"] == 1   # the tool speaks in aliases, not ids


async def test_a_track_the_catalog_no_longer_carries_is_not_a_blank_denial() -> None:
    """The window matched, but the only track is gone from the catalog (a
    personal upload, a retired lecture). The person still has a history."""
    got = await user_tracks_list(
        user_context=_ctx(_track("gone", played=_NOW - timedelta(days=1))),
        catalog_repo=_Catalog(live=set()),
        alias_map=_Aliases(),
        since=(_NOW - timedelta(days=6)).isoformat(),
    )
    assert got["history_exists"] is True


@pytest.mark.parametrize("bad", ["yesterday", "2026-13-01"])
async def test_a_bad_bound_still_says_what_is_wrong(bad: str) -> None:
    got = await _call(_ctx(_track("t1", played=_NOW)), since=bad)
    assert got["error"] == "bad_argument"
