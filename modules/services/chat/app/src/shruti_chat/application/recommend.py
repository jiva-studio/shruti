"""Topic-based "what to listen next" recommender — server port of the
mobile `usecases/discovery/buildRecommendations.ts`.

Same signal as the app: from the user's recent listening it builds a
taste profile (topic affinity = Σ weight × listened_seconds), takes the
most-listened topics, and pulls the highest-weight UNHEARD lectures on
those topics. Deterministic — no LLM. The chat node hands the result to
the synthesizer, which only phrases «недавно вы слушали про X — вот
похожее» in the user's language.

Differences from the on-device version, by design:

- The listened-seconds signal comes from `UserContextTrack.position_ms`
  (how far the user got) — the closest the server snapshot has to the
  app's per-session `listenedSeconds`.
- NO cold-start fallback to popular topics. On the discovery surface an
  empty shelf is bad UX, so the app back-fills with first-N topics. In
  chat the honest answer when there's no history is «послушай сначала
  пару лекций» — so we return `has_history=False` and let the node say
  exactly that instead of recommending blind.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

from shruti_chat.domain import UserContext
from shruti_chat.domain.user_context import as_aware


# Defaults mirror the spirit of the mobile config (a recent window, a
# handful of hot topics, a short final pick). Kept here so the node and
# the tests share one source of truth.
DEFAULT_HISTORY_WINDOW_DAYS = 30
DEFAULT_SHELF_TOPICS = 5
DEFAULT_PER_TOPIC = 10
DEFAULT_MAX_RESULTS = 6


class _TopicCatalog(Protocol):
    """The slice of CatalogRepository the recommender needs (keeps the
    use case unit-testable with a tiny fake)."""

    async def topic_weights_for_tracks(
        self, track_ids: list[str],
    ) -> list[tuple[str, str, float]]: ...

    async def top_track_ids_for_topic(
        self, topic_id: str, *, languages: list[str], limit: int,
    ) -> list[str]: ...


@dataclass(frozen=True, slots=True)
class Recommendation:
    """Result of `recommend_tracks`.

    `track_ids` is the ordered list of recommended lectures (empty when
    there's no history). `hot_topic_ids` are the topics the profile was
    built from, most-listened first — surfaced so the answer can say what
    the recommendations are based on. `has_history` distinguishes
    "nothing to recommend yet" from "history exists but no fresh tracks".
    """

    track_ids: tuple[str, ...]
    hot_topic_ids: tuple[str, ...]
    has_history: bool


def _listened_seconds(track) -> float:
    """Listened-seconds proxy for one recent track. `position_ms` is how
    far the user got; a track with no position still counts as a unit so
    a topic the user touched isn't dropped entirely."""
    if track.position_ms and track.position_ms > 0:
        return track.position_ms / 1000.0
    return 1.0


async def recommend_tracks(
    *,
    user_context: UserContext | None,
    catalog: _TopicCatalog,
    languages: list[str],
    history_window_days: int = DEFAULT_HISTORY_WINDOW_DAYS,
    shelf_topics: int = DEFAULT_SHELF_TOPICS,
    per_topic: int = DEFAULT_PER_TOPIC,
    max_results: int = DEFAULT_MAX_RESULTS,
) -> Recommendation:
    empty = Recommendation((), (), has_history=False)
    if user_context is None:
        return empty

    # Heard set within the recency window. The window only bites when both
    # `now` and a track's `last_played_at` are known; the client already
    # sends a recent slice, so tracks with no timestamp are kept.
    now = user_context.now
    window_start = (
        as_aware(now) - timedelta(days=history_window_days)
        if now is not None
        else None
    )
    seconds_by_track: dict[str, float] = {}
    for t in user_context.recent_tracks:
        if (
            window_start is not None
            and t.last_played_at is not None
            and as_aware(t.last_played_at) < window_start
        ):
            continue
        seconds_by_track[t.track_id] = _listened_seconds(t)
    if not seconds_by_track:
        return empty
    heard_ids = set(seconds_by_track)

    # Taste profile: topic affinity = Σ weight × listened_seconds. The
    # track order is the (ordered) recent-tracks order, not a set, so the
    # result doesn't depend on hashing / DB row order.
    weights = await catalog.topic_weights_for_tracks(list(seconds_by_track))
    affinity: dict[str, float] = {}
    for track_id, topic_id, weight in weights:
        seconds = seconds_by_track.get(track_id, 0.0)
        affinity[topic_id] = affinity.get(topic_id, 0.0) + weight * seconds
    if not affinity:
        return empty

    # Highest affinity first; topic_id breaks ties so the ranking is fully
    # deterministic (two topics with equal affinity always order the same).
    hot_topics = [
        topic_id
        for topic_id, _ in sorted(
            affinity.items(), key=lambda kv: (-kv[1], kv[0])
        )
    ][:shelf_topics]

    # Candidate lectures per hot topic, highest-weight first, never
    # resurfacing something already heard.
    candidates_by_topic: list[list[str]] = []
    for topic_id in hot_topics:
        ids = await catalog.top_track_ids_for_topic(
            topic_id, languages=languages, limit=per_topic,
        )
        fresh = [tid for tid in ids if tid not in heard_ids]
        if fresh:
            candidates_by_topic.append(fresh)

    # Flatten round-robin across topics so the picks stay diverse (the
    # top lecture of each hot topic before the second of any), deduped,
    # capped. Round-robin mirrors the app's "top pick per topic" first.
    recommended: list[str] = []
    seen: set[str] = set()
    depth = 0
    while len(recommended) < max_results and candidates_by_topic:
        progressed = False
        for bucket in candidates_by_topic:
            if depth >= len(bucket):
                continue
            tid = bucket[depth]
            progressed = True
            if tid in seen:
                continue
            seen.add(tid)
            recommended.append(tid)
            if len(recommended) >= max_results:
                break
        if not progressed:
            break
        depth += 1

    return Recommendation(
        track_ids=tuple(recommended),
        hot_topic_ids=tuple(hot_topics),
        has_history=True,
    )
