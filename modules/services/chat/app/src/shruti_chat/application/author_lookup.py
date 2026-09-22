"""Which corpus author a written-out name denotes.

Two callers need the same answer and must not drift: the lecture-card worker,
which resolves the speaker the router extracted, and the `lecture_authors`
attribute, which resolves the teachers someone asked to be answered from.

Resolution is across ALL locales, and the decision is token containment rather
than a score cutoff — see `author_names` for why no ratio separates "Srila
Prabhupada" (ours) from "Bhakti Caitanya Swami" (not ours).
"""

from __future__ import annotations

from shruti_chat.domain.author_lookup import (  # noqa: F401
    CANDIDATES,
    distinctive_tokens,
    names_match,
    resolve_author,
)
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)


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
