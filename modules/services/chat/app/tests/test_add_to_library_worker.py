"""Tests for `agent/graph/nodes/add_to_library_worker` (intent=add-to-library).

The worker is a deterministic terminal (no synthesizer), so the tests capture
the SSE writer stream and assert on its structure: the PRO gate (pro publishes
+ candidate cards; free → upsell, no publish), the candidate-card SSE shape +
action-before-marker ordering, the direct-URL fast path, and the empty result.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from shruti_chat.agent.graph.nodes import add_to_library_worker as atl
from shruti_chat.lecture_search.models import Candidate


@dataclass
class _Ctx:
    llm: Any | None = None
    lang: str = "en"
    request_id: str = "req-test"
    kv_cache: Any | None = None
    emitted_action_ids: set = field(default_factory=set)
    user_id: str | None = "user-1"
    jwt: str | None = "jwt-token"
    ingest_publisher: Any | None = None
    lecture_search: Any | None = None


@dataclass
class _Runtime:
    context: _Ctx


class _FakeLLM:
    """localized_reply calls structured_output(msgs, LocalizedReply, ...)."""

    async def structured_output(self, messages, schema, *, run_name=None, model=None, callbacks=None):
        return schema(line="LINE", chips=[])


class _FakePublisher:
    def __init__(self, ok: bool = True) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self._ok = ok

    async def publish(self, *, user_id: str, url: str, jwt: str) -> bool:
        self.calls.append((user_id, url, jwt))
        return self._ok


class _FakeResolver:
    def __init__(self, results: list[Candidate]) -> None:
        self._results = results
        self.calls: list[str] = []

    async def search(self, query: str, *, limit: int) -> list[Candidate]:
        self.calls.append(query)
        return list(self._results)


@pytest.fixture
def _events(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    captured: list[dict] = []
    monkeypatch.setattr(atl, "get_stream_writer", lambda: captured.append)
    return captured


def _actions(events, kind: str) -> list[dict]:
    return [
        e for e in events
        if e["type"] == "action" and e["data"].get("kind") == kind
    ]


def _delta_text(events) -> str:
    return "".join(e["data"]["text"] for e in events if e["type"] == "delta")


# ── PRO gate ────────────────────────────────────────────────────────────


async def test_free_user_gets_upsell_and_no_publish(_events) -> None:
    pub = _FakePublisher()
    res = _FakeResolver([Candidate(url="u1", title="T1")])
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=res)

    out = await atl.add_to_library_worker_node(
        {"user_query": "add this to my library", "tier": "free"}, _Runtime(ctx)
    )
    assert out == {}
    upsell = _actions(_events, "upgrade_to_pro")
    assert len(upsell) == 1
    assert upsell[0]["data"]["payload"]["reason"] == "add_to_library"
    assert "[action:upgrade_to_pro|id=" in _delta_text(_events)
    # A free user never triggers a search or a publish.
    assert pub.calls == []
    assert res.calls == []
    assert _actions(_events, "library_candidate") == []


async def test_anon_user_also_gets_upsell(_events) -> None:
    pub = _FakePublisher()
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=_FakeResolver([]))
    await atl.add_to_library_worker_node(
        {"user_query": "save this video", "tier": "anon"}, _Runtime(ctx)
    )
    assert len(_actions(_events, "upgrade_to_pro")) == 1
    assert pub.calls == []


async def test_pro_user_publishes_top_and_emits_candidate_cards(_events) -> None:
    pub = _FakePublisher(ok=True)
    res = _FakeResolver([
        Candidate(url="https://y/1", title="Bhakti 1", provider="youtube_api"),
        Candidate(url="https://y/2", title="Bhakti 2", provider="youtube_api"),
    ])
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=res)

    out = await atl.add_to_library_worker_node(
        {"user_query": "find a bhakti lecture on youtube and add it", "tier": "pro"},
        _Runtime(ctx),
    )
    assert out == {}
    # The resolver ran, and the top candidate was published (user_id + jwt + url).
    assert res.calls == ["find a bhakti lecture on youtube and add it"]
    assert pub.calls == [("user-1", "https://y/1", "jwt-token")]

    # Candidate cards: one library_candidate action + [card:cand_N] per result.
    cands = _actions(_events, "library_candidate")
    assert [c["data"]["id"] for c in cands] == ["cand_0", "cand_1"]
    assert cands[0]["data"]["payload"]["url"] == "https://y/1"
    text = _delta_text(_events)
    assert "[card:cand_0]" in text and "[card:cand_1]" in text
    # The confirmation action for the added lecture is emitted + markered.
    added = _actions(_events, "added_to_library")
    assert len(added) == 1
    assert f"[action:added_to_library|id={added[0]['data']['id']}]" in text


async def test_candidate_action_precedes_its_card_marker(_events) -> None:
    res = _FakeResolver([Candidate(url="https://y/1", title="T", provider="p")])
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=_FakePublisher(), lecture_search=res)
    await atl.add_to_library_worker_node(
        {"user_query": "add a lecture", "tier": "pro"}, _Runtime(ctx)
    )
    action_idx = next(
        i for i, e in enumerate(_events)
        if e["type"] == "action" and e["data"].get("kind") == "library_candidate"
    )
    marker_idx = next(
        i for i, e in enumerate(_events)
        if e["type"] == "delta" and "[card:cand_0]" in e["data"]["text"]
    )
    assert action_idx < marker_idx


# ── Direct-URL fast path ─────────────────────────────────────────────────


async def test_pro_direct_url_skips_search_and_publishes_link(_events) -> None:
    pub = _FakePublisher()
    res = _FakeResolver([Candidate(url="https://other", title="X")])
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=res)

    await atl.add_to_library_worker_node(
        {
            "user_query": "save https://youtu.be/abc123 to my library",
            "tier": "pro",
        },
        _Runtime(ctx),
    )
    # The pasted link is used verbatim; the resolver is NOT consulted.
    assert res.calls == []
    assert pub.calls == [("user-1", "https://youtu.be/abc123", "jwt-token")]
    cands = _actions(_events, "library_candidate")
    assert cands[0]["data"]["payload"]["url"] == "https://youtu.be/abc123"


# ── Empty result ─────────────────────────────────────────────────────────


async def test_pro_no_candidates_says_so_without_publishing(_events) -> None:
    pub = _FakePublisher()
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=_FakeResolver([]))
    out = await atl.add_to_library_worker_node(
        {"user_query": "add a lecture about nothing", "tier": "pro"}, _Runtime(ctx)
    )
    assert out == {}
    assert pub.calls == []  # nothing found → nothing published
    assert _actions(_events, "library_candidate") == []
    assert "LINE" in _delta_text(_events)  # localized "couldn't find" line
