"""Unit tests for the validated marker tools (propose_cite/card/outline).

The tools are the agent-side guard against the LLM fabricating a
plausible-looking track_id and writing it into a `[cite:...]` marker
in prose (the failure mode caught empirically on the user's device:
session "Что такое бхакти" had 8 fabricated ids across 4 replies).
With these tools, the LLM cannot inject any chip marker — only the
agent can, and only after `filter_existing_track_ids` validates.
"""

from __future__ import annotations

from typing import Any

import pytest

from shruti_chat.agent.tools.propose_cite import (
    propose_card,
    propose_cite,
    propose_outline,
)


class _StubCatalog:
    """Minimal CatalogRepository fake for the validation gate.

    Only `filter_existing_track_ids` is exercised here, so we don't bother
    implementing the rest of the port (this is a focused unit test, not an
    end-to-end roundtrip)."""

    def __init__(self, known: set[str]) -> None:
        self._known = known

    async def filter_existing_track_ids(self, ids: list[str]) -> list[str]:
        return [i for i in ids if i in self._known]


def _capturing_yield():
    """Return (yield_fn, events) where events is a list the fn appends to."""
    events: list[tuple[str, dict[str, Any]]] = []

    def _yield(ev_type: str, data: dict[str, Any]) -> None:
        events.append((ev_type, data))

    return _yield, events


# ─── propose_cite ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_propose_cite_valid_track_injects_marker_with_caption() -> None:
    catalog = _StubCatalog({"track_OkPVGYhR5PPu"})
    y, events = _capturing_yield()
    out = await propose_cite(
        track_id="track_OkPVGYhR5PPu",
        start_ms=630560,
        end_ms=684400,
        caption="совершенство жизни",
        yield_event=y,
        catalog_repo=catalog,
    )
    assert out == {"ok": True}
    assert events == [
        (
            "delta",
            {"text": "[cite:track_OkPVGYhR5PPu@630560-684400|совершенство жизни]"},
        )
    ]


@pytest.mark.asyncio
async def test_propose_cite_valid_track_no_caption_omits_pipe() -> None:
    catalog = _StubCatalog({"track_X"})
    y, events = _capturing_yield()
    out = await propose_cite(
        track_id="track_X", start_ms=0, end_ms=1000, yield_event=y, catalog_repo=catalog,
    )
    assert out == {"ok": True}
    assert events == [("delta", {"text": "[cite:track_X@0-1000]"})]


@pytest.mark.asyncio
async def test_propose_cite_fabricated_track_rejects_with_hint() -> None:
    # Empirically the 8 fabricated ids from "Что такое бхакти" session
    # (2026-05-18). They look real — correct prefix, 14 chars — but are
    # not in the catalog. Pre-fix the bubble silently rendered them as
    # broken chips.
    catalog = _StubCatalog({"track_OkPVGYhR5PPu"})  # only first cite is real
    y, events = _capturing_yield()
    out = await propose_cite(
        track_id="track_iL7KjU5Lp4pZ",
        start_ms=819000,
        end_ms=881520,
        caption="девять видов",
        yield_event=y,
        catalog_repo=catalog,
    )
    assert out["error"] == "track_not_in_catalog"
    assert out["track_id"] == "track_iL7KjU5Lp4pZ"
    assert "search_transcripts" in out["hint"]
    # NO marker leaks into the stream — that's the whole point.
    assert events == []


@pytest.mark.asyncio
async def test_propose_cite_empty_track_id_rejected() -> None:
    catalog = _StubCatalog({"track_X"})
    y, events = _capturing_yield()
    out = await propose_cite(
        track_id="", start_ms=0, end_ms=0, yield_event=y, catalog_repo=catalog,
    )
    assert out == {"error": "track_id_required"}
    assert events == []


@pytest.mark.asyncio
async def test_propose_cite_clamps_end_before_start() -> None:
    catalog = _StubCatalog({"track_X"})
    y, events = _capturing_yield()
    out = await propose_cite(
        track_id="track_X",
        start_ms=5000,
        end_ms=1000,  # invalid range
        caption="x",
        yield_event=y,
        catalog_repo=catalog,
    )
    assert out == {"ok": True}
    # end_ms clamped to start_ms, not allowed to go backwards.
    assert events == [("delta", {"text": "[cite:track_X@5000-5000|x]"})]


# ─── propose_card ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_propose_card_valid_track_injects_marker() -> None:
    catalog = _StubCatalog({"track_real"})
    y, events = _capturing_yield()
    out = await propose_card(
        track_id="track_real", yield_event=y, catalog_repo=catalog,
    )
    assert out == {"ok": True}
    assert events == [("delta", {"text": "[card:track_real]"})]


@pytest.mark.asyncio
async def test_propose_card_fabricated_track_rejects() -> None:
    catalog = _StubCatalog({"track_real"})
    y, events = _capturing_yield()
    out = await propose_card(
        track_id="track_fake", yield_event=y, catalog_repo=catalog,
    )
    assert out["error"] == "track_not_in_catalog"
    assert events == []


# ─── propose_outline ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_propose_outline_valid_track_injects_marker() -> None:
    catalog = _StubCatalog({"track_real"})
    y, events = _capturing_yield()
    out = await propose_outline(
        track_id="track_real", yield_event=y, catalog_repo=catalog,
    )
    assert out == {"ok": True}
    assert events == [("delta", {"text": "[outline:track_real]"})]


@pytest.mark.asyncio
async def test_propose_outline_fabricated_track_rejects() -> None:
    catalog = _StubCatalog({"track_real"})
    y, events = _capturing_yield()
    out = await propose_outline(
        track_id="track_fake", yield_event=y, catalog_repo=catalog,
    )
    assert out["error"] == "track_not_in_catalog"
    assert events == []
