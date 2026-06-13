"""Phase 2 — kind-aware retrieval boost.

`boost_kinds_from` detects an explicitly-requested content kind (router
content_types + keyword backstop); `_rank_key` nudges those chunks up the
rerank sort. Ordering-only — the cosine `score` (coverage gate) is untouched.
"""

from __future__ import annotations

from lectorium_chat.research.corpus_fanout import KIND_BOOST_DELTA, _RawScored, _rank_key
from lectorium_chat.research.kind_intent import boost_kinds_from


# ── boost_kinds_from ─────────────────────────────────────────────────


def test_video_query_boosts_media() -> None:
    assert "media" in boost_kinds_from("покажи видео учеников Прабхупады", {})
    assert "media" in boost_kinds_from("show me some video from his disciples", {})


def test_purport_query_boosts_commentary() -> None:
    assert "commentary" in boost_kinds_from("что такое душа, с пурпортами", {})


def test_letter_query_boosts_letter() -> None:
    assert "letter" in boost_kinds_from("letter about temple management", {})


def test_router_content_types_are_included() -> None:
    out = boost_kinds_from("anything", {"content_types": ["verse", "commentary"]})
    assert {"verse", "commentary"} <= out


def test_unknown_values_are_dropped() -> None:
    assert boost_kinds_from("x", {"content_types": ["bogus"]}) == frozenset()


def test_plain_question_has_no_boost() -> None:
    assert boost_kinds_from("что такое карма?", {}) == frozenset()


# ── _rank_key ────────────────────────────────────────────────────────


def _rs(kind: str, rerank: float | None, cosine: float) -> _RawScored:
    return _RawScored(
        chunk=None, score=cosine, kind=kind, dedup_key=(kind, cosine),
        rerank_score=rerank,
    )


def test_rank_key_boosts_requested_kind() -> None:
    media = _rs("media", 0.50, 0.50)
    letter = _rs("letter", 0.55, 0.55)
    boost = frozenset({"media"})
    # Without a boost the letter outranks the media clip.
    assert _rank_key(letter, frozenset()) > _rank_key(media, frozenset())
    # With the media boost the clip overtakes it (0.50 + 0.15 > 0.55).
    assert _rank_key(media, boost) > _rank_key(letter, boost)


def test_rank_key_noop_without_boost_kinds() -> None:
    r = _rs("media", 0.4, 0.4)
    assert _rank_key(r, frozenset()) == (0.4, 0.4)
    assert _rank_key(r, frozenset({"media"})) == (0.4 + KIND_BOOST_DELTA, 0.4)
