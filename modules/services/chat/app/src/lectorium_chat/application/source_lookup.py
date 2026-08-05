"""Which book the router meant, as the catalog spells it.

The router extracts a book the way the question named it — «ШБ», "SB", "Gita".
Downstream that value is compared against `chunks.source_id`, which holds the
catalog's opaque id, so the two must be reconciled exactly once per turn. Doing
it here, at the router, means every later hop — the fanout's library lanes, the
lexical lane, the planner's second stage, `locate` — reads one already-correct
value instead of each deciding for itself (three of them decided differently,
and two of them decided wrong).

See `domain/source_ids` for what an unresolved code costs.
"""

from __future__ import annotations

from typing import Any

from lectorium_chat.domain.source_ids import is_opaque_source_id
from lectorium_chat.observability.logging import get_logger


# The resolved id DRIVES a filter, not just a label, so a weak fuzzy match must
# not swap in a different scripture. Same bar the lecture-card worker uses.
MIN_CONFIDENCE = 0.6

log = get_logger(__name__)


async def resolve_source_id(
    catalog_repo: Any, value: str | None, *, request_id: str | None = None,
) -> str | None:
    """The catalog id for `value`, or None when it denotes no book we have.

    An input that is already a catalog id is returned untouched and costs no
    lookup — the deterministic address classifier emits that form.
    """
    text = (value or "").strip()
    if not text:
        return None
    if is_opaque_source_id(text):
        return text
    if catalog_repo is None:
        return None
    try:
        hits = await catalog_repo.resolve("source", text, lang=None, limit=1)
    except Exception:  # noqa: BLE001 — a book we cannot check is not a book we found
        log.warning("source_resolve_failed", request_id=request_id, value=text[:40])
        return None
    if not hits or hits[0].confidence < MIN_CONFIDENCE:
        return None
    return hits[0].id
