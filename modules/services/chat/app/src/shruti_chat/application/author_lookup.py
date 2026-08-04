"""Which corpus author a written-out name denotes.

Two callers need the same answer and must not drift: the lecture-card worker,
which resolves the speaker the router extracted, and the `lecture_authors`
attribute, which resolves the teachers someone asked to be answered from.

Resolution is across ALL locales, and the decision is token containment rather
than a score cutoff — see `_author_match` for why no ratio separates "Srila
Prabhupada" (ours) from "Bhakti Caitanya Swami" (not ours).
"""

from __future__ import annotations

from typing import Any

from shruti_chat.agent.graph.nodes._author_match import names_match


# Enough candidates that the right locale's row is in the pool — the fuzzy
# ranking may put another locale of another teacher above ours.
CANDIDATES = 5


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
    for hit in hits:
        if names_match(text, hit.full_name):
            return hit
    return None
