"""Unit tests for research.attribution_lookup.

Uses an in-memory fake pool that returns scripted rows per (lang, kind).
Postgres-backed integration is covered in tests/integration/test_attribution_full_flow.py.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import BaseModel

from shruti_chat.research.attribution_lookup import find_attributions
from shruti_chat.research.models import AttributionMatch


# ---- fake asyncpg-shaped pool ---------------------------------------------


class _FakeRow(dict):
    """Dict subclass mimicking asyncpg.Record (supports __getitem__)."""


class FakeConn:
    def __init__(self, rows_by_query: dict[tuple, list[_FakeRow]]) -> None:
        self.rows_by_query = rows_by_query
        self.calls: list[tuple] = []

    async def fetch(self, sql: str, *args) -> list[_FakeRow]:
        # Key is (lang_or_none, kind). Args layout differs by stage:
        #   native: (embedding, lang, embed_model, kind)
        #   cross:  (embedding, embed_model, kind)
        if "WHERE e.language" in sql:
            lang, _embed_model, kind = args[1], args[2], args[3]
            self.calls.append(("native", lang, kind))
            key = (lang, kind)
        else:
            _embed_model, kind = args[1], args[2]
            self.calls.append(("cross", None, kind))
            key = (None, kind)
        return self.rows_by_query.get(key, [])


class FakePool:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    def acquire(self):
        # asyncpg's acquire() returns an async context manager.
        return _AcquireCtx(self.conn)


class _AcquireCtx:
    def __init__(self, conn: FakeConn) -> None:
        self.conn = conn

    async def __aenter__(self) -> FakeConn:
        return self.conn

    async def __aexit__(self, exc_type, exc, tb) -> None:
        return None


def _row(aid: str, score: float, refs: list[dict] | None = None) -> _FakeRow:
    return _FakeRow(
        id=aid,
        refs_json=json.dumps(refs or [{"ref_kind": "verse", "target_id": "verse_x"}]),
        score=score,
    )


# ---- tests ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_native_match_accepted_above_threshold() -> None:
    conn = FakeConn({("ru", "pinned"): [_row("attribution_a", 0.92)]})
    pool = FakePool(conn)
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="openai/text-embedding-3-small", embed_dim=1536, pool=pool,
    )
    assert len(matches) == 1
    assert matches[0].attribution_id == "attribution_a"
    assert matches[0].stage == "native"
    assert matches[0].score == pytest.approx(0.92)


@pytest.mark.asyncio
async def test_multi_match_returns_top_k_above_accept() -> None:
    conn = FakeConn({("ru", "pinned"): [
        _row("a1", 0.95), _row("a2", 0.93), _row("a3", 0.91),
        _row("a4", 0.87), _row("a5", 0.83),
    ]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    # 4 are >= 0.85, but cap at PINNED_MAX_MATCHES=3
    assert [m.attribution_id for m in matches] == ["a1", "a2", "a3"]


@pytest.mark.asyncio
async def test_native_below_accept_falls_to_cross() -> None:
    # Native top1 is 0.78 — below 0.85 (accept_native), above 0.70 (border).
    # Border-zone triggers LLM-confirm. Pass an llm that returns NO so we
    # see the path actually fall through to []... wait, on no we return [].
    # Use a different test: native top is below 0.70 → straight to cross.
    conn = FakeConn({
        ("ru", "pinned"): [_row("a1", 0.50)],  # below border
        (None, "pinned"): [_row("a1", 0.82)],  # cross above accept_cross (0.80)
    })
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert len(matches) == 1
    assert matches[0].stage == "cross"
    assert matches[0].score == pytest.approx(0.82)


@pytest.mark.asyncio
async def test_question_border_zone_triggers_llm_confirm_yes() -> None:
    class YesLLM:
        async def structured_output(self, messages, schema, *, model=None, **_extra):
            return schema(yes=True)

    conn = FakeConn({("ru", "pinned"): [_row("a1", 0.78)]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn), llm=YesLLM(),
    )
    assert len(matches) == 1
    assert matches[0].attribution_id == "a1"


@pytest.mark.asyncio
async def test_question_border_zone_llm_says_no_returns_empty() -> None:
    class NoLLM:
        async def structured_output(self, messages, schema, *, model=None, **_extra):
            return schema(yes=False)

    conn = FakeConn({("ru", "pinned"): [_row("a1", 0.78)]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn), llm=NoLLM(),
    )
    assert matches == []


@pytest.mark.asyncio
async def test_topic_no_llm_confirm_lower_thresholds() -> None:
    # Topic with score 0.66 in cross-stage — passes BOOST_ACCEPT_SCORE_CROSS=0.65.
    conn = FakeConn({
        ("ru", "boost"): [_row("t1", 0.30)],
        (None, "boost"): [_row("t1", 0.66)],
    })
    matches = await find_attributions(
        kind="boost", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert len(matches) == 1
    assert matches[0].stage == "cross"
    assert matches[0].score == pytest.approx(0.66)


@pytest.mark.asyncio
async def test_topic_native_threshold_separate_from_cross() -> None:
    # Topic native at 0.71 — passes BOOST_ACCEPT_SCORE_NATIVE=0.70.
    conn = FakeConn({("ru", "boost"): [_row("t1", 0.71)]})
    matches = await find_attributions(
        kind="boost", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert len(matches) == 1
    assert matches[0].stage == "native"


@pytest.mark.asyncio
async def test_empty_table_returns_empty_no_errors() -> None:
    conn = FakeConn({})  # no rows for any (lang, kind)
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert matches == []


@pytest.mark.asyncio
async def test_refs_parsed_from_jsonb() -> None:
    conn = FakeConn({("ru", "pinned"): [_row("a1", 0.90, refs=[
        {"ref_kind": "verse", "target_id": "verse_BG_2_13"},
        {"ref_kind": "document", "target_id": "library_document_x"},
    ])]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert len(matches[0].refs) == 2
    assert matches[0].refs[0].ref_kind == "verse"
    assert matches[0].refs[0].target_id == "verse_BG_2_13"
    assert matches[0].refs[1].ref_kind == "document"


@pytest.mark.asyncio
async def test_native_match_at_cross_threshold_promoted_no_extra_query() -> None:
    # Native top1 is 0.81 — below 0.85 accept_native but above 0.80 accept_cross.
    # Should accept as native, NOT issue a second cross-lang query.
    conn = FakeConn({("ru", "pinned"): [_row("a1", 0.81)]})
    matches = await find_attributions(
        kind="pinned", user_q_embedding=[0.0]*1536, lang="ru",
        embed_model="m", embed_dim=1536, pool=FakePool(conn),
    )
    assert len(matches) == 1
    assert matches[0].stage == "native"
    # Verify only one SQL call (native).
    assert len(conn.calls) == 1
    assert conn.calls[0][0] == "native"
