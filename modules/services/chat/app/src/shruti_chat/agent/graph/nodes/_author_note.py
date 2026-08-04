"""Saying out loud that the chosen lecturers had nothing to say.

An answer narrowed to one teacher and built entirely from scripture looks exactly
like an answer that simply preferred scripture. The person who set the filter has
no way to tell the difference, and the difference matters: one means "they never
spoke about this", the other means "we ignored your choice".

Two situations, kept apart because they are different facts:

- the corpus holds NO lectures by them at all;
- it holds some, and none of them matched this question.

Written by `localized_reply`, so it reaches every shipped locale rather than a
hardcoded ru/en pair, and it is KV-cached per (situation, language) — the same
teacher's line is composed once and then served from cache.
"""

from __future__ import annotations

from typing import Any

from shruti_chat.observability.logging import get_logger


log = get_logger(__name__)


def has_lecture(notes: list[dict[str, Any]] | None) -> bool:
    return any((n or {}).get("type") == "lecture" for n in notes or [])


async def author_gap_note(
    ctx: Any, notes: list[dict[str, Any]] | None,
) -> str:
    """One line admitting the gap, or "" when there is nothing to admit.

    Returns "" whenever a lecture DID reach the answer, when nothing was
    narrowed, or when the line cannot be written — a missing disclaimer is a
    worse answer, never a broken turn.
    """
    scope = getattr(ctx, "author_scope", None)
    if scope is None or not scope.selection.constrained:
        return ""
    if has_lecture(notes):
        return ""

    who = scope.selection.names or "the selected lecturers"
    # `[]` means the catalog has nothing by them; `None` means the lookup failed
    # open, and then we do not get to claim anything about the corpus.
    try:
        allowed = await scope.track_ids()
    except Exception:  # noqa: BLE001
        return ""
    if allowed is None:
        return ""
    # Their own uploads with no resolved speaker fall out of a filtered answer,
    # and nothing on screen says why. Counting them turns "why is my lecture
    # missing" into something the person can act on: tag the speaker.
    untagged = await _untagged_own(ctx)
    mine = (
        f" The person also has {untagged} recording(s) in their personal library "
        f"with no speaker recorded, which is why those could not be used — "
        f"mention this in one short clause."
        if untagged else ""
    )
    if allowed:
        situation = (
            f"The user asked to be answered only from lectures by {who}. Those "
            "lectures exist in the corpus, but none of them covers this "
            "question, so the answer below is drawn from scripture and its "
            "commentaries instead. Say this in one short sentence." + mine
        )
    else:
        situation = (
            f"The user asked to be answered only from lectures by {who}. The "
            "corpus holds no lectures by them at all, so the answer below is "
            "drawn from scripture and its commentaries instead. Say this in one "
            "short sentence." + mine
        )

    from shruti_chat.agent.graph.nodes._worker_common import localized_reply

    reply = await localized_reply(ctx, situation)
    line = (reply.line or "").strip()
    log.info(
        "author_gap_note",
        request_id=getattr(ctx, "request_id", None),
        authors=len(scope.selection.ids),
        their_tracks=len(allowed),
        written=bool(line),
        untagged_own=untagged,
    )
    return line


async def _untagged_own(ctx: Any) -> int:
    """How many of this person's own uploads carry no resolved speaker.

    Zero for an anonymous turn, a library-less one, or any failure: this only
    adds a clause to a disclaimer, and a count we are unsure of is worse than
    none.
    """
    repo = getattr(ctx, "chunk_repo", None)
    user_id = getattr(ctx, "user_id", "") or ""
    if repo is None or not user_id:
        return 0
    try:
        return int(await repo.unattributed_owned_count(user_id))
    except Exception:  # noqa: BLE001
        return 0
