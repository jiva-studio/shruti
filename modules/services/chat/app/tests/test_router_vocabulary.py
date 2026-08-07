"""The router and the code that reads it must speak the same words.

Two ways the same sentence got lost between them:

- the prompt told the model to say `"transcript"` for spoken material, and
  retrieval only knows `"lecture"` — so the ONE kind a person spelled out was
  the one kind that got no boost. A live turn extracted
  `["verse","commentary","prose_chapter","transcript"]` and only `transcript`
  was dropped;
- `kind` («утренние прогулки») has always been extracted and never read: the
  filter slot was a hardcoded `tag_ids: None`, so the search narrowed by year
  and city and then served ordinary lectures from them.

The catalog spells recording types `tag_morning_walk`, and has no `tag_lecture`
at all — everything is a lecture — which is why the mapping is checked against
the dictionary instead of assumed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from shruti_chat.research.kind_intent import boost_kinds_from


# ── content_types ─────────────────────────────────────────────────────────


def test_the_word_the_prompt_uses_boosts_lectures() -> None:
    assert "lecture" in boost_kinds_from("что о карме", {"content_types": ["transcript"]})


def test_the_live_extraction_keeps_all_four_kinds() -> None:
    # Verbatim from production (trace 1291fcc3…): three survived, one didn't.
    kinds = boost_kinds_from(
        "Что говорят священные писания о карме?",
        {"content_types": ["verse", "commentary", "prose_chapter", "transcript"]},
    )
    assert kinds == frozenset({"verse", "commentary", "prose_chapter", "lecture"})


def test_a_single_string_is_read_the_same_way() -> None:
    assert boost_kinds_from("x", {"content_types": "transcript"}) == frozenset({"lecture"})


def test_a_word_that_names_no_kind_boosts_nothing() -> None:
    assert boost_kinds_from("x", {"content_types": ["podcast"]}) == frozenset()


def test_the_prompt_no_longer_teaches_the_dead_word() -> None:
    from pathlib import Path

    import shruti_chat

    md = (
        Path(shruti_chat.__file__).resolve().parent
        / "agent" / "prompts" / "router.md"
    ).read_text(encoding="utf-8")
    line = next(l for l in md.splitlines() if l.startswith("- content_types"))
    assert '"lecture"' in line and '"transcript"' not in line


# ── kind → the catalog's tag ──────────────────────────────────────────────


@dataclass
class _Tag:
    id: str
    full_name: str
    confidence: float = 1.0


class _TagCatalog:
    """The real tag dictionary, trimmed: ids are `tag_<kind>`, and the fuzzy
    resolver answers with near-misses as well as the match."""

    _TAGS = {
        "tag_morning_walk": "Morning Walk",
        "tag_conversation": "Conversation",
        "tag_address": "Address",
        "tag_bhajan": "Bhajan",
    }

    def __init__(self) -> None:
        self.asked: list[str] = []

    async def resolve(self, kind: str, text: str, *, lang=None, limit: int = 5):
        self.asked.append(f"{kind}:{text}")
        want = text.strip().lower()
        hits = [_Tag(i, n) for i, n in self._TAGS.items() if want in n.lower()]
        # Whatever else the scorer grazes rides along, as production's does.
        rest = [_Tag(i, n, 0.3) for i, n in self._TAGS.items() if _Tag(i, n) not in hits]
        return (hits + rest)[:limit]


@dataclass
class _Ctx:
    catalog_repo: Any


async def _filters(kind: object, catalog: Any = None) -> tuple[dict, list[str]]:
    from shruti_chat.agent.graph.nodes.find_tracks_worker import (
        _build_filters,
        _stated,
    )

    full = await _build_filters(_Ctx(catalog or _TagCatalog()), {"kind": kind})
    return full, _stated(full)


async def test_morning_walks_actually_narrow_the_search() -> None:
    flt, _ = await _filters("morning_walk")
    assert flt["tag_ids"] == ["tag_morning_walk"]


async def test_the_word_is_humanized_before_it_is_looked_up() -> None:
    catalog = _TagCatalog()
    await _filters("morning_walk", catalog)
    assert catalog.asked == ["tag:morning walk"]


async def test_a_plain_lecture_narrows_nothing() -> None:
    # There is no `tag_lecture` — every recording is a lecture. Accepting the
    # resolver's best guess here would have filtered on «Речь».
    flt, stated = await _filters("lecture")
    assert flt["tag_ids"] is None
    assert "kind" not in stated


async def test_a_kind_the_catalog_never_heard_of_narrows_nothing() -> None:
    flt, _ = await _filters("podcast")
    assert flt["tag_ids"] is None


@pytest.mark.parametrize("kind", [None, "", "   ", 7])
async def test_no_kind_asks_the_catalog_nothing(kind: object) -> None:
    catalog = _TagCatalog()
    flt, _ = await _filters(kind, catalog)
    assert flt["tag_ids"] is None
    assert catalog.asked == []


async def test_a_broken_catalog_just_does_not_narrow() -> None:
    class _Broken:
        async def resolve(self, *_a, **_kw):
            raise RuntimeError("catalog gone")

    flt, _ = await _filters("morning_walk", _Broken())
    assert flt["tag_ids"] is None


async def test_the_type_outlives_the_city_when_constraints_are_given_up() -> None:
    """Someone who asked for morning walks would rather see one from another
    year than a lecture from the right one — so `kind` is given up after the
    date and the city, and before the teacher."""
    from shruti_chat.agent.graph.nodes.find_tracks_worker import (
        _build_filters,
        _stated,
    )

    class _Loc(_TagCatalog):
        async def resolve(self, kind: str, text: str, *, lang=None, limit: int = 5):
            if kind == "location":
                return [_Tag("loc_bombay", "Bombay")]
            return await super().resolve(kind, text, lang=lang, limit=limit)

    full = await _build_filters(
        _Ctx(_Loc()),
        {"kind": "morning_walk", "location": "Bombay", "year": 1976},
        author_id="author_prabhupada",
    )
    assert _stated(full) == ["date", "location", "kind", "author"]


# ── the type as people actually say it ────────────────────────────────────


class _RealScores:
    """The catalog's own scorer, as measured against it on 2026-08-06.

    The phrase people say is NOT what the dictionary holds: «утренние прогулки»
    against the entry «Прогулка» comes out at 0.56 — under the 0.6 bar — while
    the bare word clears it easily. That gap is the whole reason the lookup
    tries the words as well as the phrase.
    """

    _SCORES = {
        "утренние прогулки": ("tag_morning_walk", 0.56),
        "утренних прогулок": ("tag_morning_walk", 0.56),
        "прогулки": ("tag_morning_walk", 0.88),
        "прогулок": ("tag_morning_walk", 0.88),
        "утренняя прогулка": ("tag_morning_walk", 1.0),
        "morning walks": ("tag_morning_walk", 0.96),
        "беседах": ("tag_conversation", 0.92),
        "инициации": ("tag_initiation", 0.89),
        # Every recording is a lecture; there is no tag for it, and the nearest
        # row is «Речь».
        "лекция": ("tag_address", 0.4),
        "лекции": ("tag_address", 0.4),
    }

    def __init__(self) -> None:
        self.asked: list[str] = []

    async def resolve(self, kind: str, text: str, *, lang=None, limit: int = 1):
        self.asked.append(text)
        hit = self._SCORES.get(text.strip().lower())
        return [_Tag(hit[0], hit[0], hit[1])] if hit else []


@pytest.mark.parametrize(
    ("said", "tag"),
    [
        ("утренние прогулки", "tag_morning_walk"),
        ("утренних прогулок", "tag_morning_walk"),
        ("утренняя прогулка", "tag_morning_walk"),
        ("morning walks", "tag_morning_walk"),
        ("беседах", "tag_conversation"),
        ("инициации", "tag_initiation"),
    ],
)
async def test_the_type_is_found_from_the_words_people_use(said, tag) -> None:
    flt, _ = await _filters(said, _RealScores())
    assert flt["tag_ids"] == [tag]


async def test_the_phrase_is_tried_before_its_words() -> None:
    catalog = _RealScores()
    await _filters("утренние прогулки", catalog)
    assert catalog.asked[0] == "утренние прогулки"
    assert "прогулки" in catalog.asked, "the phrase alone is under the bar — 0.56"


@pytest.mark.parametrize("said", ["лекция", "лекции"])
async def test_an_ordinary_lecture_still_narrows_nothing(said) -> None:
    # 0.4 for «Речь» is the scorer grasping; a filter here is one nobody asked for.
    flt, stated = await _filters(said, _RealScores())
    assert flt["tag_ids"] is None
    assert "kind" not in stated


async def test_short_words_are_not_looked_up_on_their_own() -> None:
    """«о беседах» must not send «о» to the dictionary — a two-letter query
    matches noise."""
    catalog = _RealScores()
    await _filters("о беседах", catalog)
    assert "о" not in catalog.asked


def test_the_prompt_no_longer_carries_a_list_of_types() -> None:
    from pathlib import Path

    import shruti_chat

    md = (
        Path(shruti_chat.__file__).resolve().parent
        / "agent" / "prompts" / "router.md"
    ).read_text(encoding="utf-8")
    assert "vyasa_puja" not in md and "press_conf" not in md
    assert "tag_" not in md
