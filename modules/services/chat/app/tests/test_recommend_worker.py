"""Unit tests for agent.graph.nodes.recommend_worker — the deterministic
"what to listen next" node (intent=recommend)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes import recommend_worker as rw
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.domain import UserContext
from lectorium_chat.domain.user_context import UserContextTrack


@dataclass
class _Ctx:
    catalog_repo: Any | None = None
    user_context: Any | None = None
    aliases: TurnAliasMap = field(default_factory=TurnAliasMap)
    lang: str = "ru"
    request_id: str = "req-test"


@dataclass
class _Runtime:
    context: _Ctx


class _Catalog:
    def __init__(self, *, weights, top_tracks, names, titles) -> None:
        self._weights = weights
        self._top_tracks = top_tracks
        self._names = names
        self._titles = titles

    async def topic_weights_for_tracks(self, track_ids):
        out = []
        for tid in track_ids:
            for topic_id, weight in self._weights.get(tid, []):
                out.append((tid, topic_id, weight))
        return out

    async def top_track_ids_for_topic(self, topic_id, *, languages, limit):
        return self._top_tracks.get(topic_id, [])[:limit]

    async def topic_names(self, topic_ids, *, lang):
        return {tid: self._names[tid] for tid in topic_ids if tid in self._names}

    async def get_titles(self, track_ids, *, lang):
        return {tid: self._titles[tid] for tid in track_ids if tid in self._titles}


@pytest.fixture(autouse=True)
def _silence_stream_writer(monkeypatch: pytest.MonkeyPatch) -> None:
    # get_stream_writer only works inside a running graph; the node just
    # emits a status event, irrelevant to what we assert.
    monkeypatch.setattr(rw, "get_stream_writer", lambda: (lambda _payload: None))


async def test_no_history_emits_listen_first_note() -> None:
    ctx = _Ctx(
        catalog_repo=_Catalog(weights={}, top_tracks={}, names={}, titles={}),
        user_context=UserContext(recent_tracks=()),
    )
    out = await rw.recommend_worker_node({}, _Runtime(ctx))
    notes = out["tool_results"]
    assert len(notes) == 1
    assert "NO LISTENING HISTORY" in notes[0]["text"]
    # No lecture cards minted.
    assert all("ref" not in n for n in notes)


async def test_missing_catalog_repo_degrades_to_note() -> None:
    ctx = _Ctx(catalog_repo=None, user_context=UserContext(recent_tracks=()))
    out = await rw.recommend_worker_node({}, _Runtime(ctx))
    assert len(out["tool_results"]) == 1
    assert "NO LISTENING HISTORY" in out["tool_results"][0]["text"]


async def test_history_emits_directive_plus_lecture_cards() -> None:
    aliases = TurnAliasMap()
    ctx = _Ctx(
        aliases=aliases,
        user_context=UserContext(recent_tracks=(
            UserContextTrack(track_id="t1", position_ms=600_000),
        )),
        catalog_repo=_Catalog(
            weights={"t1": [("bhakti", 1.0)]},
            top_tracks={"bhakti": ["r1", "r2"]},
            names={"bhakti": "Бхакти"},
            titles={"r1": "Лекция 1", "r2": "Лекция 2"},
        ),
    )
    out = await rw.recommend_worker_node({}, _Runtime(ctx))
    notes = out["tool_results"]

    # First note: the directive, naming the topic, no ref.
    assert "RECOMMENDATIONS" in notes[0]["text"]
    assert "Бхакти" in notes[0]["text"]
    assert "ref" not in notes[0]

    # Then one lecture card per recommended (unheard) track.
    cards = notes[1:]
    assert [c["type"] for c in cards] == ["lecture", "lecture"]
    assert all(isinstance(c["ref"], int) for c in cards)
    assert [c["title"] for c in cards] == ["Лекция 1", "Лекция 2"]
    # Refs resolve back to the real track ids via the same alias map.
    resolved = [aliases.resolve(c["ref"]).track_id for c in cards]
    assert resolved == ["r1", "r2"]
