"""Tests for `agent/graph/nodes/add_to_library_worker` (intent=add-to-library).

The worker is a deterministic terminal (no synthesizer), so the tests capture
the SSE writer stream and assert on its structure: the PRO gate (free → upsell,
no publish), a SEARCH query → candidate cards only with NO publish (+ action-
before-marker ordering), a CONCRETE lecture URL → exactly one direct publish
with NO candidate cards, and the empty result.

A search query never publishes `ingest.request` — that happens when the user
taps a card's "Add to library" action. A concrete lecture URL (YouTube
watch/short link or a direct audio file) is an explicit target and IS published
directly, PRO-gated, with a confirmation card instead of candidate cards.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes import add_to_library_worker as atl
from lectorium_chat.lecture_search.models import Candidate


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
        self.titles: list[str] = []
        self.authors: list[str] = []
        self._ok = ok

    async def publish(
        self,
        *,
        user_id: str,
        url: str,
        jwt: str,
        title: str = "",
        author: str = "",
        request_id: str = "",
    ) -> bool:
        self.calls.append((user_id, url, jwt))
        self.titles.append(title)
        self.authors.append(author)
        return self._ok


class _FakeResolver:
    def __init__(self, results: list[Candidate]) -> None:
        self._results = results
        self.calls: list[str] = []

    async def search(self, query: str, *, limit: int) -> list[Candidate]:
        self.calls.append(query)
        return list(self._results)


@pytest.fixture(autouse=True)
def _no_oembed_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub the YouTube oEmbed lookup so the direct-publish path never touches
    the network in tests. A title test overrides this locally."""

    async def _stub(_url: str) -> tuple[str, str, str]:
        return "", "", ""

    monkeypatch.setattr(atl, "_youtube_oembed", _stub)


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
    assert _actions(_events, "add_to_library") == []


async def test_anon_user_also_gets_upsell(_events) -> None:
    pub = _FakePublisher()
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=_FakeResolver([]))
    await atl.add_to_library_worker_node(
        {"user_query": "save this video", "tier": "anon"}, _Runtime(ctx)
    )
    assert len(_actions(_events, "upgrade_to_pro")) == 1
    assert pub.calls == []


async def test_pro_user_emits_candidate_cards_without_publishing(_events) -> None:
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
    # The resolver ran, but NOTHING was published — the worker only offers
    # candidates; publishing is the card action's job.
    assert res.calls == ["find a bhakti lecture on youtube and add it"]
    assert pub.calls == []

    # Candidate cards: one add_to_library action + [action:add_to_library|id=…]
    # marker per result — the shared contract the mobile card renders.
    cands = _actions(_events, "add_to_library")
    assert [c["data"]["id"] for c in cands] == ["cand_0", "cand_1"]
    assert cands[0]["data"]["payload"]["url"] == "https://y/1"
    text = _delta_text(_events)
    assert "[action:add_to_library|id=cand_0]" in text
    assert "[action:add_to_library|id=cand_1]" in text
    # No speculative confirmation card — publishing hasn't happened yet.
    assert _actions(_events, "added_to_library") == []
    assert "[action:added_to_library" not in text


async def test_search_term_combines_author_and_topic(_events) -> None:
    # A lecturer + topic web search must stay anchored to the PERSON — searching
    # a bare topic ("karma") returns pop songs, not the teacher's lectures.
    res = _FakeResolver([Candidate(url="https://y/1", title="X", provider="youtube_api")])
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=_FakePublisher(), lecture_search=res)

    await atl.add_to_library_worker_node(
        {
            "user_query": "Find Niranjana Swami's lectures about karma and add to my library",
            "tier": "pro",
            "extracted_args": {"author": "Niranjana Swami", "topic": "karma"},
        },
        _Runtime(ctx),
    )
    assert res.calls == ["Niranjana Swami karma"]


async def test_candidate_action_precedes_its_card_marker(_events) -> None:
    res = _FakeResolver([Candidate(url="https://y/1", title="T", provider="p")])
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=_FakePublisher(), lecture_search=res)
    await atl.add_to_library_worker_node(
        {"user_query": "add a lecture", "tier": "pro"}, _Runtime(ctx)
    )
    action_idx = next(
        i for i, e in enumerate(_events)
        if e["type"] == "action" and e["data"].get("kind") == "add_to_library"
    )
    marker_idx = next(
        i for i, e in enumerate(_events)
        if e["type"] == "delta"
        and "[action:add_to_library|id=cand_0]" in e["data"]["text"]
    )
    assert action_idx < marker_idx


# ── Concrete lecture URL → direct publish ────────────────────────────────


async def test_pro_youtube_url_publishes_directly_no_cards(_events) -> None:
    pub = _FakePublisher(ok=True)
    res = _FakeResolver([Candidate(url="https://other", title="X")])
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=res)

    out = await atl.add_to_library_worker_node(
        {
            "user_query": "save https://youtu.be/abc123 to my library",
            "tier": "pro",
        },
        _Runtime(ctx),
    )
    assert out == {}
    # A concrete lecture URL is published DIRECTLY: no search, exactly one
    # ingest.request, and NO candidate cards.
    assert res.calls == []
    assert pub.calls == [("user-1", "https://youtu.be/abc123", "jwt-token")]
    assert _actions(_events, "add_to_library") == []
    # B2: a concrete URL publishes SILENTLY — no action event, no inline marker
    # (the client has no "done" card, so a marker would render as raw text). The
    # confirmation is the text line plus the My Library shelf.
    assert _actions(_events, "added_to_library") == []
    assert "[action:added_to_library" not in _delta_text(_events)
    assert "LINE" in _delta_text(_events)


async def test_direct_publish_carries_oembed_title(
    _events, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The client hands us only the URL, so the worker resolves the real title
    # (oEmbed) and publishes it — the pre-ready library card shows the lecture's
    # name instead of "Untitled".
    async def _titled(_url: str) -> tuple[str, str, str]:
        return "Kirtan Mela with Niranjana Swami", "Purusottam108", "https://img/x.jpg"

    monkeypatch.setattr(atl, "_youtube_oembed", _titled)
    pub = _FakePublisher(ok=True)
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=_FakeResolver([]))

    await atl.add_to_library_worker_node(
        {"user_query": "save https://youtu.be/abc123 to my library", "tier": "pro"},
        _Runtime(ctx),
    )
    assert pub.titles == ["Kirtan Mela with Niranjana Swami"]


async def test_pro_watch_url_with_params_publishes_once(_events) -> None:
    pub = _FakePublisher(ok=True)
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=_FakeResolver([]))
    await atl.add_to_library_worker_node(
        {
            "user_query": "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s add it",
            "tier": "pro",
        },
        _Runtime(ctx),
    )
    assert len(pub.calls) == 1
    assert pub.calls[0][1] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s"
    assert _actions(_events, "add_to_library") == []


async def test_pro_audio_url_publishes_directly(_events) -> None:
    pub = _FakePublisher(ok=True)
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=pub, lecture_search=_FakeResolver([]))
    await atl.add_to_library_worker_node(
        {"user_query": "add https://cdn.example.org/talks/lecture-01.mp3", "tier": "pro"},
        _Runtime(ctx),
    )
    assert pub.calls == [
        ("user-1", "https://cdn.example.org/talks/lecture-01.mp3", "jwt-token")
    ]
    # B2: silent publish — no action events of either kind.
    assert _actions(_events, "added_to_library") == []
    assert _actions(_events, "add_to_library") == []


async def test_pro_broker_unconfigured_still_confirms(_events) -> None:
    # No ingest_publisher (STREAMS_REDIS_URL unset → NoopIngestPublisher).
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=None, lecture_search=_FakeResolver([]))
    out = await atl.add_to_library_worker_node(
        {"user_query": "add https://youtu.be/xyz789", "tier": "pro"},
        _Runtime(ctx),
    )
    assert out == {}
    # No broker → no crash; still confirms via the text line. B2 publishes
    # silently, so there is no action event to carry a queued flag.
    assert _actions(_events, "added_to_library") == []
    assert _actions(_events, "add_to_library") == []
    assert "LINE" in _delta_text(_events)


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


# ── YouTube cover derivation ─────────────────────────────────────────────


def test_youtube_thumb_from_various_url_shapes() -> None:
    thumb = atl._youtube_thumb
    assert thumb("https://youtu.be/abcDEF12345") == (
        "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg"
    )
    assert thumb("https://www.youtube.com/watch?v=abcDEF12345&t=30s") == (
        "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg"
    )
    assert thumb("https://youtube.com/shorts/abcDEF12345") == (
        "https://i.ytimg.com/vi/abcDEF12345/hqdefault.jpg"
    )
    # Non-YouTube (direct audio, article) → no cover.
    assert thumb("https://cdn.example.org/talks/lecture-01.mp3") == ""
    assert thumb("https://example.com/some/article") == ""
    assert thumb("") == ""


async def test_search_uses_extracted_topic_not_the_raw_command(_events) -> None:
    # The router extracts a clean topic; the worker must search THAT, not the
    # full command sentence (a keyword engine returns nothing for the latter).
    res = _FakeResolver([Candidate(url="https://y/1", title="Bhakti", provider="serpapi")])
    ctx = _Ctx(llm=_FakeLLM(), ingest_publisher=_FakePublisher(), lecture_search=res)
    await atl.add_to_library_worker_node(
        {
            "user_query": "найди на ютубе лекцию про бхакти и добавь в мою библиотеку",
            "tier": "pro",
            "extracted_args": {"topic": "бхакти"},
        },
        _Runtime(ctx),
    )
    assert res.calls == ["бхакти"]
    assert _actions(_events, "add_to_library")  # candidate card emitted
