"""The catalog's source id, and how to tell it from the code a person says.

Two spellings of the same book are in play. A person — and the router that reads
them — says «ШБ» / "SB"; every chunk-level filter compares against
`chunks.source_id`, which holds the catalog's opaque id (`source_0OX6Db6QpdJ4`).

Handing the short code to those filters is not a weaker filter, it is an empty
one. Production answered «Что Шримад-Бхагаватам говорит о карме?» from 213
lecture fragments and ZERO verses, purports or chapters: all four library lanes
ran and matched nothing, because no row has `source_id = 'SB'`. The same question
without the book named retrieved 306 of them.

So the short code is resolved to the opaque id once per turn (application layer),
and anything that still reaches a chunk filter unresolved is dropped here rather
than passed through — searching every book is a worse answer than searching the
right one, and a far better one than "the corpus has nothing".
"""

from __future__ import annotations


# Every catalog source id starts with this; short codes ("SB", "БГ") never do.
OPAQUE_PREFIX = "source_"


def is_opaque_source_id(value: str | None) -> bool:
    """True when `value` is a catalog id, not a book's short code."""
    return bool(value) and str(value).startswith(OPAQUE_PREFIX)


def chunk_source_filter(value: str | None) -> str | None:
    """The value safe to compare against `chunks.source_id` — or None (no filter)."""
    return str(value) if is_opaque_source_id(value) else None
