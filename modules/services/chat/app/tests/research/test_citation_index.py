"""The `[^N]` index space must not be able to shift silently.

`build_outline` numbers over `tool_results` at planner entry;
`augment_thin_theses` numbers fresh chunks `len(base_notes) + 1 + i`; the
planner therefore has to append exactly `new_commentaries + fresh_chunks`; and
the append-reducer concatenates that onto state.

Swap the two lists in the planner and every fresh chunk's `[^N]` lands on a
commentary and vice versa — with no exception, no empty result and no failing
test. An answer that cites the wrong source, confidently. These pin the rule.
"""

from __future__ import annotations

from shruti_chat.research.citation_index import citation_index_holds


def _note(tag: str) -> dict:
    return {"type": "lecture", "text": tag}


def test_the_correct_order_holds() -> None:
    prior = [_note("a"), _note("b")]
    commentaries = [_note("c1")]
    fresh = [_note("f1"), _note("f2")]

    assert citation_index_holds(
        prior=prior,
        stage2_base=prior + commentaries,
        appended=commentaries + fresh,
        new_commentaries=commentaries,
    )


def test_swapping_the_appended_lists_is_caught() -> None:
    """THE bug this exists for: `fresh_chunks + new_commentaries` instead of
    `new_commentaries + fresh_chunks`."""
    prior = [_note("a")]
    commentaries = [_note("c1")]
    fresh = [_note("f1")]

    assert not citation_index_holds(
        prior=prior,
        stage2_base=prior + commentaries,
        appended=fresh + commentaries,  # swapped
        new_commentaries=commentaries,
    )


def test_a_base_pool_that_skipped_the_commentaries_is_caught() -> None:
    """If Stage 2 numbers against the prior notes alone, every fresh index is
    short by the commentary count."""
    prior = [_note("a"), _note("b")]
    commentaries = [_note("c1")]

    assert not citation_index_holds(
        prior=prior,
        stage2_base=prior,  # forgot the commentaries
        appended=commentaries,
        new_commentaries=commentaries,
    )


def test_equal_but_distinct_notes_do_not_satisfy_it() -> None:
    """Identity, not equality: two notes can compare equal and still be
    different entries in the pool, which is exactly how a subtle reordering
    would slip past a `==` check."""
    commentaries = [_note("same")]
    look_alike = [_note("same")]
    assert commentaries == look_alike

    assert not citation_index_holds(
        prior=[],
        stage2_base=commentaries,
        appended=look_alike,
        new_commentaries=commentaries,
    )


def test_dropping_a_commentary_from_the_append_is_caught() -> None:
    prior = [_note("a")]
    commentaries = [_note("c1"), _note("c2")]
    fresh = [_note("f1")]

    assert not citation_index_holds(
        prior=prior,
        stage2_base=prior + commentaries,
        appended=[commentaries[0]] + fresh,  # c2 lost
        new_commentaries=commentaries,
    )


def test_no_stage2_work_still_holds() -> None:
    """The common path: nothing thin, nothing fetched."""
    prior = [_note("a")]

    assert citation_index_holds(
        prior=prior, stage2_base=prior, appended=[], new_commentaries=[],
    )
