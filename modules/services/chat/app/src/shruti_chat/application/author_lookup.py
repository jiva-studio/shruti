"""Which corpus author, or which of a user's own recorded speakers, a
written-out name denotes.

A name reaches us in whatever script it was written — the router normalizes the
speaker it extracts to English, a person asking types their own — so the catalog
is asked across ALL locales and the name matcher decides among the candidates.

`resolve_author` is the one place that turns a name into a catalog row: the
lecture-card worker, the router's turn author, the `lecture_authors` attribute
and the private-upload indexer all go through it, so they cannot disagree.
"""

from __future__ import annotations

from typing import Any, Protocol

from shruti_chat.domain.entities import ResolvedEntity
from shruti_chat.domain.name_matching import NameMatcher
from shruti_chat.domain.ports.catalog_repository import ResolveKind
from shruti_chat.observability.logging import get_logger

log = get_logger(__name__)

# Enough candidates that the right locale's row is in the pool — the fuzzy
# ranking may put another locale of another teacher above ours.
CANDIDATES = 5


class AuthorCatalog(Protocol):
    async def resolve(
        self, kind: ResolveKind, text: str, *, lang: str | None, limit: int,
    ) -> list[ResolvedEntity]: ...


async def resolve_author(
    matcher: NameMatcher,
    catalog: AuthorCatalog | None,
    name: str,
    *,
    request_id: str | None = None,
) -> ResolvedEntity | None:
    """The corpus author `name` denotes, or None when the corpus lacks them.

    None is also the answer when the catalog is unreachable: a name we cannot
    check is not a name we can claim to have found.
    """
    text = (name or "").strip()
    if not text or catalog is None:
        return None
    try:
        hits = await catalog.resolve("author", text, lang=None, limit=CANDIDATES)
    except Exception as exc:  # noqa: BLE001 — an unreachable catalog finds nobody
        log.warning(
            "author_resolve_failed",
            request_id=request_id, name=text[:60], error=str(exc),
        )
        return None
    return matcher.select(text, hits)


async def own_speaker_names(
    matcher: NameMatcher,
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
    return [s for s in stored if matcher.names_match(text, s)]
