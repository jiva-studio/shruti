"""Every locale of a help page must describe the same product.

`get_help` serves `*.<locale>.md` and falls back to English only when the
locale has NO page at all (`agent/tools/help.py`). So a page that exists but
is a version behind is worse than a missing one: it is served confidently, and
the assistant answers "what can you do" with a feature list from before the
lecturer filter, the personal library, recommendations and listening history.
That is what twelve locales did while en and ru moved on.

Counting list items and headings is a coarse proxy for "the same things are
described" — it cannot check meaning, but it catches the failure that actually
happens: a page updated in one language and forgotten in the rest. Bold-bullet
counts were the first try and are NOT usable: several translations phrase the
same list without the bold lead-in, so that metric flags formatting, not drift.
"""

from __future__ import annotations

import os
from collections import defaultdict
from pathlib import Path

import pytest


_CORPUS = Path(
    os.environ.get(
        "HELP_CORPUS_DIR",
        str(Path(__file__).resolve().parents[4] / "docs" / "help"),
    )
)


def _pages() -> dict[str, dict[str, Path]]:
    """`{page_id: {locale: path}}` for the bundled help corpus."""
    out: dict[str, dict[str, Path]] = defaultdict(dict)
    for path in sorted(_CORPUS.glob("*.md")):
        page_id, _, locale = path.name[: -len(".md")].rpartition(".")
        if page_id:
            out[page_id][locale] = path
    return out


def _shape(path: Path) -> tuple[int, int]:
    """(list items, headings) — the structure a translation is expected to keep."""
    lines = path.read_text(encoding="utf-8").splitlines()
    return (
        sum(1 for l in lines if l.startswith("- ")),
        sum(1 for l in lines if l.startswith("## ")),
    )


pytestmark = pytest.mark.skipif(
    not _CORPUS.is_dir(), reason=f"help corpus not present at {_CORPUS}"
)


def test_the_corpus_is_where_we_think_it_is() -> None:
    # Guards the path above: a silent miss would skip every check below.
    assert _pages(), f"no help pages under {_CORPUS}"


@pytest.mark.parametrize("page_id", sorted(_pages()))
def test_every_locale_of_a_page_lists_the_same_capabilities(page_id: str) -> None:
    locales = _pages()[page_id]
    if "en" not in locales:
        pytest.skip(f"{page_id} has no English original to compare against")
    want = _shape(locales["en"])
    behind = {
        loc: got
        for loc, path in locales.items()
        if (got := _shape(path)) != want
    }
    assert not behind, (
        f"{page_id}: English has (items, headings)={want}, these locales differ "
        f"{behind} — a stale page is SERVED, never falls back to English."
    )
