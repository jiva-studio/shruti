"""What to give up when the exact request has nothing.

«Покажи утренние прогулки 1976 года в Бомбее» returned two unrelated Russian
talks under «с немного изменённой датой и местом» — while the ten walks it
asked for sat in the corpus, from 1976, from Bombay, in English. The search
walked a ladder in the user's language first, so it gave up the year, then the
city, then the very type of recording, and only then would it have considered
crossing the language boundary. Every one of those was a worse trade than
saying «на русском их нет, вот они по-английски».

The order that replaces it:

1. everything asked for, in the language of the conversation;
2. everything asked for, in any language — a real answer about the right
   lectures beats an invented one about the wrong ones;
3. everything but ONE constraint, every such near-miss at once and merged, so
   the reply can name which one has nothing («в Бомбее нет, но за 76 есть»)
   instead of a blur of dropped filters;
4. cumulative give-up, as before, when even that is empty.

The teacher is never one of the near-misses: somebody else's words are a
different answer, not a near one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from lectorium_chat.agent.graph.nodes.find_tracks_worker import (
    _find_lectures,
    _stated,
    _without,
)


_ALL = {
    "author_ids": None, "source_id": None, "location_id": None, "tag_ids": None,
    "date_from": None, "date_to": None, "anniversary_md": None,
    "ref_prefix": None, "ref_from": None, "ref_to": None,
}


def _filters(**kw: Any) -> dict:
    return {**_ALL, **kw}


_WALKS_1976_BOMBAY = _filters(
    tag_ids=["tag_morning_walk"], location_id="loc_bombay",
    date_from="1976-01-01", date_to="1976-12-31",
)


@dataclass
class _Chunk:
    track_id: str
    lang: str = "ru"
    start_ms: int = 120_000
    end_ms: int = 130_000
    text: str = "…"


@dataclass
class _Scored:
    chunk: _Chunk
    score: float = 0.8


class _Corpus:
    """Answers a search only when the filter+language match one of its shelves.

    A shelf is keyed by the constraints it satisfies, so a test states the
    corpus as it really is («these ten exist, in English, for exactly this
    request») and the code has to find them.
    """

    def __init__(self, shelves: dict[tuple[frozenset[str], str], list[str]]) -> None:
        self._shelves = shelves
        self.searched: list[tuple[frozenset[str], str | None]] = []

    def _kept(self, flt: dict) -> frozenset[str]:
        return frozenset(_stated(flt))

    async def search(self, flt: dict, *, lang: str | None) -> list[_Scored]:
        kept = self._kept(flt)
        self.searched.append((kept, lang))
        out: list[_Scored] = []
        for (shelf_kept, shelf_lang), tracks in self._shelves.items():
            if shelf_kept != kept:
                continue
            if lang is not None and lang != shelf_lang:
                continue
            out += [_Scored(_Chunk(t, lang=shelf_lang)) for t in tracks]
        return out


@dataclass
class _Ctx:
    lang_code: str = "ru"
    request_id: str = "req"


@pytest.fixture(autouse=True)
def _search_through_the_corpus(monkeypatch: pytest.MonkeyPatch):
    """Point the worker's one search primitive at the fake corpus."""
    import lectorium_chat.agent.graph.nodes.find_tracks_worker as mod

    holder: dict[str, _Corpus] = {}

    async def _search(_ctx, _embedding, flt, *, lang):
        return await holder["corpus"].search(flt, lang=lang)

    monkeypatch.setattr(mod, "_search", _search)
    return holder


async def _run(holder, corpus: _Corpus, flt: dict, lang: str = "ru"):
    holder["corpus"] = corpus
    return await _find_lectures(_Ctx(lang_code=lang), [0.0], flt)


# ── the case that started it ──────────────────────────────────────────────


async def test_the_exact_lectures_in_another_language_beat_the_wrong_ones_at_home(
    _search_through_the_corpus,
) -> None:
    everything = frozenset({"date", "location", "kind"})
    corpus = _Corpus({
        # The ten real ones: right year, right city, right type — English only.
        (everything, "en"): [f"walk{i}" for i in range(10)],
        # And the Russian talks the ladder used to serve instead.
        (frozenset(), "ru"): ["unrelated1", "unrelated2"],
    })
    found = await _run(_search_through_the_corpus, corpus, _WALKS_1976_BOMBAY)

    assert [sc.chunk.track_id for sc in found.lectures][:2] == ["walk0", "walk1"]
    assert found.other_language is True
    assert found.relaxed == ""          # nothing was given up
    assert found.partial is False


async def test_the_users_language_still_wins_when_it_has_the_same_lectures(
    _search_through_the_corpus,
) -> None:
    everything = frozenset({"date", "location", "kind"})
    corpus = _Corpus({
        (everything, "ru"): ["ru_walk"],
        (everything, "en"): ["en_walk"],
    })
    found = await _run(_search_through_the_corpus, corpus, _WALKS_1976_BOMBAY)

    assert [sc.chunk.track_id for sc in found.lectures] == ["ru_walk"]
    assert found.other_language is False


# ── near-misses, merged and named ─────────────────────────────────────────


async def test_both_near_misses_come_back_together(
    _search_through_the_corpus,
) -> None:
    """«в Бомбее нет, но за 76 есть» — and the other way round. One list, and
    the reply can now name which constraint had nothing."""
    corpus = _Corpus({
        # 1976 morning walks, elsewhere.
        (frozenset({"date", "kind"}), "ru"): ["walk_vrindavan"],
        # Bombay morning walks, another year.
        (frozenset({"location", "kind"}), "ru"): ["walk_bombay_75"],
    })
    found = await _run(_search_through_the_corpus, corpus, _WALKS_1976_BOMBAY)

    assert sorted(sc.chunk.track_id for sc in found.lectures) == [
        "walk_bombay_75", "walk_vrindavan",
    ]
    assert set(found.relaxed.split(",")) == {"date", "location"}
    assert found.partial is True


async def test_a_lecture_that_two_near_misses_both_found_is_offered_once(
    _search_through_the_corpus,
) -> None:
    corpus = _Corpus({
        (frozenset({"date", "kind"}), "ru"): ["same"],
        (frozenset({"location", "kind"}), "ru"): ["same"],
    })
    found = await _run(_search_through_the_corpus, corpus, _WALKS_1976_BOMBAY)
    assert [sc.chunk.track_id for sc in found.lectures] == ["same"]


async def test_near_misses_at_home_beat_near_misses_abroad(
    _search_through_the_corpus,
) -> None:
    corpus = _Corpus({
        (frozenset({"date", "kind"}), "ru"): ["ru_near"],
        (frozenset({"location", "kind"}), "en"): ["en_near"],
    })
    found = await _run(_search_through_the_corpus, corpus, _WALKS_1976_BOMBAY)

    assert [sc.chunk.track_id for sc in found.lectures] == ["ru_near"]
    assert found.other_language is False


async def test_the_teacher_is_not_offered_up_as_a_near_miss(
    _search_through_the_corpus,
) -> None:
    """Dropping the author answers with somebody else's words — a different
    answer, not a near one. It stays a last resort."""
    flt = _filters(author_ids=["author_x"], date_from="1976-01-01", date_to="1976-12-31")
    corpus = _Corpus({
        # Everything by other teachers in 1976 — reachable only by giving up
        # the author, which must not happen while the year alone can be dropped.
        (frozenset({"date"}), "ru"): ["someone_else"],
        (frozenset({"author"}), "ru"): ["his_other_year"],
    })
    found = await _run(_search_through_the_corpus, corpus, flt)

    assert [sc.chunk.track_id for sc in found.lectures] == ["his_other_year"]
    assert found.relaxed == "date"


# ── the floor ─────────────────────────────────────────────────────────────


async def test_when_no_single_near_miss_has_anything_it_gives_up_by_degrees(
    _search_through_the_corpus,
) -> None:
    corpus = _Corpus({(frozenset({"kind"}), "ru"): ["only_kind_left"]})
    found = await _run(_search_through_the_corpus, corpus, _WALKS_1976_BOMBAY)

    assert [sc.chunk.track_id for sc in found.lectures] == ["only_kind_left"]
    assert found.relaxed == "date,location"
    assert found.partial is False       # these DID give up both, not one each


async def test_an_empty_corpus_says_so(_search_through_the_corpus) -> None:
    found = await _run(_search_through_the_corpus, _Corpus({}), _WALKS_1976_BOMBAY)
    assert found.lectures == []
    assert found.relaxed == ""


async def test_a_plain_topical_search_pays_for_one_query(
    _search_through_the_corpus,
) -> None:
    """No constraints, nothing to relax — the hot path must not double its ANN
    cost speculatively looking for another language."""
    corpus = _Corpus({(frozenset(), "ru"): ["hit"]})
    found = await _run(_search_through_the_corpus, corpus, _filters())

    assert [sc.chunk.track_id for sc in found.lectures] == ["hit"]
    assert corpus.searched == [(frozenset(), "ru")]


async def test_a_plain_topical_search_still_crosses_the_language_when_empty(
    _search_through_the_corpus,
) -> None:
    corpus = _Corpus({(frozenset(), "en"): ["en_hit"]})
    found = await _run(_search_through_the_corpus, corpus, _filters())

    assert [sc.chunk.track_id for sc in found.lectures] == ["en_hit"]
    assert found.other_language is True


# ── the mechanics the strategy rests on ───────────────────────────────────


def test_dropping_a_constraint_clears_every_key_it_owns() -> None:
    left = _without(_WALKS_1976_BOMBAY, ["date"])
    assert left["date_from"] is None and left["date_to"] is None
    assert left["location_id"] == "loc_bombay"
    assert left["tag_ids"] == ["tag_morning_walk"]


def test_the_stated_constraints_are_listed_narrowest_first() -> None:
    flt = _filters(
        ref_prefix="2", source_id="source_SB", author_ids=["a"],
        location_id="l", tag_ids=["t"], date_from="1976-01-01",
    )
    assert _stated(flt) == [
        "reference", "date", "location", "kind", "author", "source",
    ]


# ── a request with no topic ───────────────────────────────────────────────


class _WeakCorpus:
    """The corpus as production has it: the exactly-matching lectures score far
    below the topical floor, because the request they match is metadata, not a
    subject. Measured on prod: 0.228 for the Russian phrasing, 0.394 for the
    English one, against a floor of 0.45."""

    def __init__(self, score: float = 0.23) -> None:
        self._score = score
        self.floors: list[float] = []

    async def search(self, flt: dict, *, lang: str | None) -> list[_Scored]:
        if _stated(flt) != ["date", "location", "kind"]:
            return []
        if lang not in (None, "en"):   # they exist in English only, as on prod
            return []
        return [_Scored(_Chunk(f"walk{i}", lang="en"), self._score) for i in range(3)]


async def test_a_request_that_is_only_metadata_is_served_by_the_metadata(
    _search_through_the_corpus,
) -> None:
    """Nothing to be relevant TO: the filters are the whole request, and the
    score's only job is to order what they selected."""
    _search_through_the_corpus["corpus"] = _WeakCorpus()
    found = await _find_lectures(
        _Ctx(), [0.0], _WALKS_1976_BOMBAY, topical=False,
    )
    assert [sc.chunk.track_id for sc in found.lectures] == ["walk0", "walk1", "walk2"]
    assert found.relaxed == ""
    assert found.other_language is True


async def test_a_topical_request_keeps_the_floor(
    _search_through_the_corpus,
) -> None:
    """«лекции 1976 про преданность» has something to be relevant to, so a
    lecture that merely carries the right year must not be served as if it
    answered the question — that is what the floor is for."""
    _search_through_the_corpus["corpus"] = _WeakCorpus()
    found = await _find_lectures(
        _Ctx(), [0.0], _WALKS_1976_BOMBAY, topical=True,
    )
    assert found.lectures == []


async def test_the_floor_still_applies_to_the_near_misses(
    _search_through_the_corpus,
) -> None:
    """Relaxing a constraint is a guess about what the person meant; a
    low-scoring guess is noise, so only the EXACT set gets the open floor."""
    corpus = _WeakCorpus()

    async def _search(flt, *, lang):
        if _stated(flt) == ["date", "kind"]:
            return [_Scored(_Chunk("weak_near_miss", lang="ru"), 0.2)]
        return []

    corpus.search = _search
    _search_through_the_corpus["corpus"] = corpus
    found = await _find_lectures(_Ctx(), [0.0], _WALKS_1976_BOMBAY, topical=False)
    assert found.lectures == []


# ── a search that fails is a search that found nothing ────────────────────


async def test_one_stalled_query_does_not_kill_the_turn(
    _search_through_the_corpus,
) -> None:
    """Twice in five days a Postgres timeout inside the semantic search
    propagated out of the worker and the person got an empty bubble — no cards,
    no line, nothing. Every other lookup here already degrades to "found
    nothing"; this one did not, and with several variants searched at once a
    single slow lane must cost that lane alone."""
    class _OneLaneStalls:
        async def search(self, flt, *, lang):
            if lang == "ru":                      # the user's language times out
                raise TimeoutError("statement timeout")
            if _stated(flt) == ["date", "location", "kind"]:
                return [_Scored(_Chunk("walk", lang="en"))]
            return []

    holder = _search_through_the_corpus
    holder["corpus"] = _OneLaneStalls()
    found = await _find_lectures(_Ctx(), [0.0], _WALKS_1976_BOMBAY)

    assert [sc.chunk.track_id for sc in found.lectures] == ["walk"]
    assert found.other_language is True


async def test_every_query_failing_is_an_honest_empty(
    _search_through_the_corpus,
) -> None:
    class _AllStall:
        async def search(self, flt, *, lang):
            raise TimeoutError("statement timeout")

    holder = _search_through_the_corpus
    holder["corpus"] = _AllStall()
    found = await _find_lectures(_Ctx(), [0.0], _WALKS_1976_BOMBAY)

    assert found.lectures == []      # the worker then offers what it offers on empty


async def test_the_plain_search_survives_a_stall_too(
    _search_through_the_corpus,
) -> None:
    """The turn that first showed this («Browse by author») carried no filters
    at all, so it never reached the fan-out."""
    class _StallThenAnswer:
        def __init__(self) -> None:
            self.calls = 0

        async def search(self, flt, *, lang):
            self.calls += 1
            if self.calls == 1:
                raise TimeoutError("statement timeout")
            return [_Scored(_Chunk("found", lang="en"))]

    holder = _search_through_the_corpus
    holder["corpus"] = _StallThenAnswer()
    found = await _find_lectures(_Ctx(), [0.0], _filters())

    assert [sc.chunk.track_id for sc in found.lectures] == ["found"]


# ── what the search costs ─────────────────────────────────────────────────


async def test_the_slow_lane_is_not_opened_when_the_fast_one_answers(
    _search_through_the_corpus,
) -> None:
    """A language-less lookup cannot use the per-(kind,lang) partial index:
    measured against the live index it is 1954 ms over the whole corpus versus
    12 ms with a language. Issuing it alongside the language one meant every
    constrained turn paid for the slowest query shape we have — and two ANN
    timeouts followed. It is needed only when the fast one comes back empty."""
    everything = frozenset({"date", "location", "kind"})
    corpus = _Corpus({(everything, "ru"): ["found_at_home"]})
    found = await _run(_search_through_the_corpus, corpus, _WALKS_1976_BOMBAY)

    assert [sc.chunk.track_id for sc in found.lectures] == ["found_at_home"]
    assert corpus.searched == [(everything, "ru")], corpus.searched


async def test_the_slow_lane_still_runs_when_it_is_the_only_answer(
    _search_through_the_corpus,
) -> None:
    everything = frozenset({"date", "location", "kind"})
    corpus = _Corpus({(everything, "en"): ["only_in_english"]})
    found = await _run(_search_through_the_corpus, corpus, _WALKS_1976_BOMBAY)

    assert [sc.chunk.track_id for sc in found.lectures] == ["only_in_english"]
    assert found.other_language is True
    assert (everything, None) in corpus.searched


async def test_near_misses_abroad_are_not_searched_when_home_has_them(
    _search_through_the_corpus,
) -> None:
    corpus = _Corpus({(frozenset({"date", "kind"}), "ru"): ["near_at_home"]})
    await _run(_search_through_the_corpus, corpus, _WALKS_1976_BOMBAY)

    langless = [c for c in corpus.searched if c[1] is None and c[0] != frozenset(
        {"date", "location", "kind"})]
    assert not langless, f"searched abroad for nothing: {langless}"
