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

from lectorium_chat.research.kind_intent import boost_kinds_from


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

    import lectorium_chat

    md = (
        Path(lectorium_chat.__file__).resolve().parent
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
    from lectorium_chat.agent.graph.nodes.find_tracks_worker import _build_filters

    ladder = await _build_filters(_Ctx(catalog or _TagCatalog()), {"kind": kind})
    return ladder[0][1], [label for label, _ in ladder]


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
    flt, rungs = await _filters("lecture")
    assert flt["tag_ids"] is None
    assert "kind" not in rungs


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


async def test_the_type_outlives_the_city_when_the_ladder_relaxes() -> None:
    """Someone who asked for morning walks would rather see one from another
    year than a lecture from the right one — so `kind` is given up after the
    date and the city, and before the teacher."""
    from lectorium_chat.agent.graph.nodes.find_tracks_worker import _build_filters

    class _Loc(_TagCatalog):
        async def resolve(self, kind: str, text: str, *, lang=None, limit: int = 5):
            if kind == "location":
                return [_Tag("loc_bombay", "Bombay")]
            return await super().resolve(kind, text, lang=lang, limit=limit)

    ladder = await _build_filters(
        _Ctx(_Loc()),
        {"kind": "morning_walk", "location": "Bombay", "year": 1976},
        author_id="author_prabhupada",
    )
    assert [label for label, _ in ladder] == [
        "", "date", "date,location", "date,location,kind",
        "date,location,kind,author",
    ]
