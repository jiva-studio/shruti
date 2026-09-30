"""`fetch_refs` degrades a failed lookup to no chunks, and says so."""

from __future__ import annotations

from typing import Any

import pytest
from structlog.testing import capture_logs

from shruti_chat.agent.turn_aliases import TurnAliasMap
from shruti_chat.research.models import AttributionRef
from shruti_chat.research.refs import fetch_refs


class _FallbackFails:
    """The user's language has no chunks; the language-agnostic retry fails."""

    async def get_chunks_by_target(self, *, lang: str | None, **_k: Any) -> list[Any]:
        if lang is None:
            raise ConnectionError("pool exhausted")
        return []

    async def get_chunks_by_track_fragment(self, *, lang: str | None, **_k: Any) -> list[Any]:
        if lang is None:
            raise ConnectionError("pool exhausted")
        return []


@pytest.mark.parametrize(("ref", "event"), [
    (AttributionRef(ref_kind="verse", target_id="bg-2-13"), "fetch_refs_lookup_failed"),
    (AttributionRef(ref_kind="track", target_id="t1@0-1000"), "fetch_refs_track_failed"),
])
async def test_a_failed_fallback_lookup_is_logged(ref: AttributionRef, event: str) -> None:
    with capture_logs() as logs:
        out = await fetch_refs(
            [ref], chunk_repo=_FallbackFails(), alias_map=TurnAliasMap(),
            lang="uk", canonical_score=0.85,
        )

    assert out == []
    failures = [e for e in logs if e["event"] == event]
    assert len(failures) == 1, logs
    assert failures[0]["target_id"] == ref.target_id
    assert failures[0]["lang"] is None
    assert failures[0]["error"] == "pool exhausted"
