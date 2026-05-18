"""Unit tests for propose_playlist's catalog validation contract.

The tool already filtered track_ids via the catalog before this change
(silent drop). The new behaviour returns the dropped subset to the LLM
so the model can correct its surrounding prose (e.g. "Я собрал
плейлист из 10 лекций..." when actually only 6 were valid). If
EVERY id is rejected, the action event is suppressed entirely and the
tool returns an error.
"""

from __future__ import annotations

from typing import Any

import pytest

from lectorium_chat.agent.tools.actions import propose_playlist


class _StubCatalog:
    def __init__(self, known: set[str]) -> None:
        self._known = known

    async def filter_existing_track_ids(self, ids: list[str]) -> list[str]:
        return [i for i in ids if i in self._known]


def _capturing_yield():
    events: list[tuple[str, dict[str, Any]]] = []

    def _yield(ev_type: str, data: dict[str, Any]) -> None:
        events.append((ev_type, data))

    return _yield, events


@pytest.mark.asyncio
async def test_propose_playlist_all_valid_emits_action_event() -> None:
    catalog = _StubCatalog({"track_A", "track_B", "track_C"})
    y, events = _capturing_yield()
    out = await propose_playlist(
        name="Бхакти",
        track_ids=["track_A", "track_B", "track_C"],
        yield_event=y,
        catalog_repo=catalog,
    )
    assert out["ok"] is True
    assert out["validated_track_ids"] == ["track_A", "track_B", "track_C"]
    assert out["rejected_track_ids"] == []
    assert len(events) == 1
    assert events[0][0] == "action"
    assert events[0][1]["kind"] == "create_playlist"
    assert events[0][1]["track_ids"] == ["track_A", "track_B", "track_C"]


@pytest.mark.asyncio
async def test_propose_playlist_partial_valid_reports_rejected_to_llm() -> None:
    # The mixed-validity case: model thought it had 4 tracks but only 2
    # are real. Pre-fix the model would say "playlist of 4 lectures"
    # while the card showed 2 — a silent contradiction. The new contract
    # surfaces `rejected_track_ids` so the model can fix its prose.
    catalog = _StubCatalog({"track_A", "track_C"})
    y, events = _capturing_yield()
    out = await propose_playlist(
        name="Mixed",
        track_ids=["track_A", "track_FAKE_1", "track_C", "track_FAKE_2"],
        yield_event=y,
        catalog_repo=catalog,
    )
    assert out["ok"] is True
    assert out["validated_track_ids"] == ["track_A", "track_C"]
    assert sorted(out["rejected_track_ids"]) == ["track_FAKE_1", "track_FAKE_2"]
    # Action event uses only the validated subset
    assert events[0][1]["track_ids"] == ["track_A", "track_C"]


@pytest.mark.asyncio
async def test_propose_playlist_all_invalid_suppresses_action_event() -> None:
    catalog = _StubCatalog({"track_A"})
    y, events = _capturing_yield()
    out = await propose_playlist(
        name="Garbage",
        track_ids=["track_FAKE_1", "track_FAKE_2"],
        yield_event=y,
        catalog_repo=catalog,
    )
    assert out["error"] == "all_track_ids_invalid"
    assert sorted(out["rejected_track_ids"]) == ["track_FAKE_1", "track_FAKE_2"]
    # No action SSE event leaks out — the bubble doesn't get a broken card.
    assert events == []


@pytest.mark.asyncio
async def test_propose_playlist_empty_name_rejects_early() -> None:
    catalog = _StubCatalog({"track_A"})
    y, events = _capturing_yield()
    out = await propose_playlist(
        name="   ", track_ids=["track_A"], yield_event=y, catalog_repo=catalog,
    )
    assert out == {"error": "name_required"}
    assert events == []


@pytest.mark.asyncio
async def test_propose_playlist_caps_at_30_track_ids() -> None:
    catalog = _StubCatalog({f"track_{i}" for i in range(50)})
    y, events = _capturing_yield()
    out = await propose_playlist(
        name="Big",
        track_ids=[f"track_{i}" for i in range(50)],
        yield_event=y,
        catalog_repo=catalog,
    )
    assert out["ok"] is True
    # Cap is MAX_PLAYLIST_TRACKS (30 in actions.py). The remaining 20 are
    # dropped silently before catalog lookup, not counted as rejected.
    assert len(out["validated_track_ids"]) == 30
    assert out["rejected_track_ids"] == []
