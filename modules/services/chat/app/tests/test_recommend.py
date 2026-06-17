"""Tests for the deterministic topic-affinity recommender
(`application/recommend.py`) — the server port of the mobile
`buildRecommendations.ts`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from shruti_chat.application.recommend import recommend_tracks
from shruti_chat.domain import UserContext
from shruti_chat.domain.user_context import UserContextTrack


class FakeCatalog:
    """Tiny in-memory stand-in for the topic slice of CatalogRepository."""

    def __init__(
        self,
        *,
        weights: dict[str, list[tuple[str, float]]],
        top_tracks: dict[str, list[str]],
    ) -> None:
        # track_id -> [(topic_id, weight), ...]
        self._weights = weights
        # topic_id -> [track_id, ...] (highest-weight first)
        self._top_tracks = top_tracks
        self.seen_languages: list[list[str]] = []

    async def topic_weights_for_tracks(
        self, track_ids: list[str],
    ) -> list[tuple[str, str, float]]:
        out: list[tuple[str, str, float]] = []
        for tid in track_ids:
            for topic_id, weight in self._weights.get(tid, []):
                out.append((tid, topic_id, weight))
        return out

    async def top_track_ids_for_topic(
        self, topic_id: str, *, languages: list[str], limit: int,
    ) -> list[str]:
        self.seen_languages.append(languages)
        return self._top_tracks.get(topic_id, [])[:limit]


def _track(track_id: str, *, position_ms: int | None = None,
           last_played_at: datetime | None = None) -> UserContextTrack:
    return UserContextTrack(
        track_id=track_id, position_ms=position_ms, last_played_at=last_played_at,
    )


async def test_no_user_context_has_no_history() -> None:
    rec = await recommend_tracks(
        user_context=None, catalog=FakeCatalog(weights={}, top_tracks={}),
        languages=["ru"],
    )
    assert rec.has_history is False
    assert rec.track_ids == ()
    assert rec.hot_topic_ids == ()


async def test_empty_recent_tracks_has_no_history() -> None:
    rec = await recommend_tracks(
        user_context=UserContext(recent_tracks=()),
        catalog=FakeCatalog(weights={}, top_tracks={}),
        languages=["ru"],
    )
    assert rec.has_history is False
    assert rec.track_ids == ()


async def test_topic_affinity_orders_and_excludes_heard() -> None:
    # t1 listened 600s, t2 listened 300s.
    uc = UserContext(recent_tracks=(
        _track("t1", position_ms=600_000),
        _track("t2", position_ms=300_000),
    ))
    catalog = FakeCatalog(
        weights={
            "t1": [("A", 1.0), ("B", 0.5)],
            "t2": [("A", 0.2), ("C", 1.0)],
        },
        # heard t1/t2 appear here too — must be filtered out of results.
        top_tracks={
            "A": ["t1", "t3", "t4"],
            "B": ["t1", "t5"],
            "C": ["t6"],
        },
    )
    rec = await recommend_tracks(user_context=uc, catalog=catalog, languages=["ru"])

    # affinity: A=1.0*600 + 0.2*300 = 660; B=0.5*600 = 300; C=1.0*300 = 300.
    # A first; B before C (stable sort on the tie).
    assert rec.hot_topic_ids == ("A", "B", "C")
    assert rec.has_history is True
    # Round-robin across topics (top of each before seconds), heard excluded.
    assert rec.track_ids == ("t3", "t5", "t6", "t4")
    assert "t1" not in rec.track_ids and "t2" not in rec.track_ids


async def test_max_results_caps_output() -> None:
    uc = UserContext(recent_tracks=(_track("t1", position_ms=10_000),))
    catalog = FakeCatalog(
        weights={"t1": [("A", 1.0)]},
        top_tracks={"A": ["r1", "r2", "r3", "r4", "r5"]},
    )
    rec = await recommend_tracks(
        user_context=uc, catalog=catalog, languages=["ru"], max_results=3,
    )
    assert rec.track_ids == ("r1", "r2", "r3")


async def test_languages_are_passed_through() -> None:
    uc = UserContext(recent_tracks=(_track("t1", position_ms=10_000),))
    catalog = FakeCatalog(
        weights={"t1": [("A", 1.0)]}, top_tracks={"A": ["r1"]},
    )
    await recommend_tracks(user_context=uc, catalog=catalog, languages=["en"])
    assert catalog.seen_languages and all(
        langs == ["en"] for langs in catalog.seen_languages
    )


async def test_history_window_drops_stale_tracks() -> None:
    now = datetime(2026, 6, 17, 12, 0, tzinfo=timezone.utc)
    uc = UserContext(
        now=now,
        recent_tracks=(
            _track("fresh", position_ms=10_000, last_played_at=now - timedelta(days=2)),
            _track("stale", position_ms=10_000, last_played_at=now - timedelta(days=400)),
        ),
    )
    catalog = FakeCatalog(
        weights={"fresh": [("A", 1.0)], "stale": [("B", 1.0)]},
        top_tracks={"A": ["r_fresh"], "B": ["r_stale"]},
    )
    rec = await recommend_tracks(
        user_context=uc, catalog=catalog, languages=["ru"], history_window_days=30,
    )
    # Only the in-window track shapes the profile.
    assert rec.hot_topic_ids == ("A",)
    assert rec.track_ids == ("r_fresh",)


async def test_missing_position_still_counts_track() -> None:
    # A track opened but with no position still contributes (unit weight),
    # so a touched topic isn't silently dropped.
    uc = UserContext(recent_tracks=(_track("t1", position_ms=None),))
    catalog = FakeCatalog(
        weights={"t1": [("A", 2.0)]}, top_tracks={"A": ["r1"]},
    )
    rec = await recommend_tracks(user_context=uc, catalog=catalog, languages=["ru"])
    assert rec.has_history is True
    assert rec.hot_topic_ids == ("A",)
    assert rec.track_ids == ("r1",)
