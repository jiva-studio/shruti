"""Which corpus author a written-out name denotes.

Two callers need the same answer and must not drift: the lecture-card worker,
which resolves the speaker the router extracted, and the `lecture_authors`
attribute, which resolves the teachers someone asked to be answered from.

Resolution is across ALL locales, and the decision is token containment rather
than a score cutoff — see `author_names` for why no ratio separates "Srila
Prabhupada" (ours) from "Bhakti Caitanya Swami" (not ours).
"""

from __future__ import annotations

from typing import Any

from shruti_chat.application.author_names import names_match
from shruti_chat.observability.logging import get_logger


# Enough candidates that the right locale's row is in the pool — the fuzzy
# ranking may put another locale of another teacher above ours.
CANDIDATES = 5

log = get_logger(__name__)


async def resolve_author(catalog_repo: Any, name: str) -> Any | None:
    """The corpus author `name` denotes, or None when the corpus lacks them.

    None is also the answer when the catalog is unreachable: a name we cannot
    check is not a name we can claim to have found.
    """
    text = (name or "").strip()
    if not text or catalog_repo is None:
        return None
    try:
        hits = await catalog_repo.resolve(
            "author", text, lang=None, limit=CANDIDATES,
        )
    except Exception:  # noqa: BLE001
        return None
    # Two passes so the returned row is the one whose SCRIPT was asked for: the
    # dictionary holds every locale of an author, and a Cyrillic question deserves
    # the Cyrillic name back even though romanized matching would accept either.
    from shruti_chat.application.author_names import distinctive_tokens

    for hit in hits:
        if _covers_same_script(text, hit.full_name):
            return hit
    for hit in hits:
        if names_match(text, hit.full_name):
            return hit
    return None


def _covers_same_script(query: str, candidate: str) -> bool:
    from shruti_chat.application.author_names import _covers, distinctive_tokens

    wanted, have = distinctive_tokens(query), distinctive_tokens(candidate)
    return bool(wanted and have and _covers(wanted, have))


async def own_speaker_names(
    private_repo: Any,
    user_id: str,
    name: str,
    *,
    request_id: str | None = None,
) -> list[str]:
    """Which of this person's OWN recorded speaker names denote `name`.

    A personal library is mostly teachers the curated corpus never heard of, so a
    name the catalog cannot place is looked for here — over the few distinct names
    one library holds, with the same matcher, so «Rohini Suta» finds all three
    spellings three different ingests wrote.

    Empty for an anonymous turn, a library-less one, or any failure: naming a
    teacher we cannot place must degrade to "no constraint", never to a crash.
    """
    text = (name or "").strip()
    if not text or private_repo is None or not user_id:
        return []
    try:
        stored = await private_repo.get_own_author_names(user_id)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "own_speaker_names_failed", request_id=request_id, error=str(exc),
        )
        return []
    return [s for s in stored if names_match(text, s)]
