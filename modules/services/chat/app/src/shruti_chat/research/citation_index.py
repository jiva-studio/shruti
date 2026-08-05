"""The `[^N]` index space — the one invariant nothing was enforcing.

A citation marker `[^N]` is a 1-based position into the turn's note pool. That
pool is assembled across four places, and they agree only by convention:

1. `build_outline` numbers `supporting_notes` over `tool_results` as it stood
   at planner entry.
2. `augment_thin_theses` numbers each fresh chunk `len(base_notes) + 1 + i`,
   where `base_notes` is (those notes + the Stage 1 commentaries).
3. `synthesis_planner` therefore has to return exactly
   `new_commentaries + fresh_chunks`, in that order.
4. The `tool_results` append-reducer concatenates that onto state, and
   `synthesizer_turn` re-derives positions from the result.

Swapping the two lists at step 3 renumbers every fresh chunk onto a commentary
and vice versa. There is no exception, no empty result, no failing test — just
an answer that cites the wrong source with full confidence. In a service whose
whole value is faithful attribution, that is the worst shape a bug can take.

This module holds the check so the rule has a name and a place, rather than
living only in prose spread across five files.
"""

from __future__ import annotations

from typing import Any, Sequence


def citation_index_holds(
    *,
    prior: Sequence[Any],
    stage2_base: Sequence[Any],
    appended: Sequence[Any],
    new_commentaries: Sequence[Any],
) -> bool:
    """True when the pool the augmenter numbered against matches what the
    reducer will actually build.

    Two conditions, both necessary:

    - the base pool is exactly `prior + new_commentaries` in length, so the
      augmenter's `len(base) + 1 + i` lands where the reducer will put it;
    - the appended list STARTS with those same commentary objects, so nothing
      shifts them. Identity, not equality: two notes can compare equal and
      still be different pool entries.
    """
    if len(stage2_base) != len(prior) + len(new_commentaries):
        return False
    if len(appended) < len(new_commentaries):
        return False
    return all(a is b for a, b in zip(appended, new_commentaries))
