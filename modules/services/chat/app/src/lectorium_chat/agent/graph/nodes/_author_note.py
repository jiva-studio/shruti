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

from lectorium_chat.observability.logging import get_logger


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
    # Their own uploads may be in another language than the answer. That is worth
    # saying rather than hiding — «его лекции есть, но на английском» is an
    # answer; silence reads as "nothing exists".
    other_langs = await _their_languages(ctx, scope)
    langs = (
        f" Their recordings in the personal library are in {', '.join(other_langs)},"
        " not the language of this answer — say which language they are in."
        if other_langs else ""
    )
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
    # A selection on a teacher only the LIBRARY knows resolves to no corpus tracks
    # by definition — that is not "they have nothing", and saying so while citing
    # their own recording is a plain contradiction. Production did exactly that:
    # «Лекций Рохини Суты Прабху нет» above four fragments of his.
    if scope.selection.raw_names and not allowed:
        situation = (
            f"The user asked to be answered only from lectures by {who}. The shared "
            "corpus has none by them and their own recordings did not cover this "
            "question either, so the answer below is drawn from scripture. Say this "
            "in one short sentence, WITHOUT claiming their recordings do not exist."
        ) + langs + mine
    elif allowed:
        situation = (
            f"The user asked to be answered only from lectures by {who}. Those "
            "lectures exist in the corpus, but none of them covers this "
            "question, so the answer below is drawn from scripture and its "
            "commentaries instead. Say this in one short sentence." + langs + mine
        )
    else:
        situation = (
            f"The user asked to be answered only from lectures by {who}. The "
            "corpus holds no lectures by them at all, so the answer below is "
            "drawn from scripture and its commentaries instead. Say this in one "
            "short sentence." + langs + mine
        )

    from lectorium_chat.agent.graph.nodes._worker_common import localized_reply

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


async def _their_languages(ctx: Any, scope: Any) -> list[str]:
    """Languages the chosen lecturers' OWN recordings are in, when the answer's
    language is not among them.

    Empty whenever we cannot say it confidently: no repository, no user, a failure,
    or the recordings do exist in the answer's language (then the miss is about the
    topic, not the language, and mentioning it would mislead).
    """
    repo = getattr(ctx, "chunk_repo", None)
    user_id = getattr(ctx, "user_id", "") or ""
    if repo is None or not user_id or not scope.selection.explicit:
        return []
    try:
        langs = await repo.owned_langs_for_authors(
            user_id,
            list(scope.selection.ids),
            list(scope.selection.raw_names),
        )
    except Exception:  # noqa: BLE001
        return []
    answer_lang = (getattr(ctx, "lang_code", "") or "").split("-")[0]
    others = sorted({lg for lg in langs if lg and lg.split("-")[0] != answer_lang})
    return others


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
