"""No prompt keeps its own copy of what is in the library.

A list of nine book codes lived in the router prompt while the catalog held
nineteen sources, so «Шикшаштака 1 найди лекции» was answered out of the
Nārada-bhakti-sūtra — the nearest thing on a list that could not contain what
was asked for. The same list had grown, by hand, into four other files.

The rule this pins is not "the list is current" — lists rot, and nobody
notices until a person asks for the book that is missing. It is "there is no
list": the model names things in words, the catalog resolves them, and adding a
book to the library is enough to make it askable.

Two things are deliberately still allowed:

- the *shape* of an identifier (`tag_*`, `source_*`) where a prompt tells the
  model these are internal and must not be shown to anyone;
- `tag_ids` and `tag_resolve` — a parameter and a tool are not catalog values.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import shruti_chat


_PROMPTS = Path(shruti_chat.__file__).resolve().parent / "agent" / "prompts"

# Concrete tag ids: `tag_morning_walk`, not the `tag_*` wildcard or `tag_ids`.
_TAG_ID = re.compile(r"\btag_(?!ids\b|resolve\b)[a-z]{3,}(?:_[a-z]+)*\b")

# The book codes that used to be enumerated. One or two in a sentence is an
# example; three or more in one line is a list pretending to be documentation.
_CODES = ("BG", "SB", "CC", "KB", "NoI", "ISO", "BS", "MM", "NBS", "NOD", "TLC")


def _prompt_files() -> list[Path]:
    return sorted(_PROMPTS.glob("*.md"))


def test_there_are_prompts_to_check() -> None:
    # Without this a moved directory turns every check below into a pass.
    assert len(_prompt_files()) > 5


@pytest.mark.parametrize("path", _prompt_files(), ids=lambda p: p.name)
def test_no_prompt_names_a_concrete_tag(path: Path) -> None:
    found = sorted(set(_TAG_ID.findall(path.read_text(encoding="utf-8"))))
    assert not found, (
        f"{path.name} names catalog tags {found} — the dictionary is the only "
        "place that knows which types exist; let the model say the words and "
        "resolve them."
    )


@pytest.mark.parametrize("path", _prompt_files(), ids=lambda p: p.name)
def test_no_prompt_enumerates_the_library(path: Path) -> None:
    offenders = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        hits = [c for c in _CODES if re.search(rf"\b{re.escape(c)}\b", line)]
        if len(hits) >= 3:
            offenders.append(f"line {i}: {hits}")
    assert not offenders, (
        f"{path.name} carries a list of books ({'; '.join(offenders)}). The "
        "catalog has nineteen sources and grows; a list here can only fall "
        "behind it — «Шикшаштака» is what that costs."
    )


def test_the_one_tool_that_must_have_a_list_builds_it_from_the_code() -> None:
    """`chunks_get_by_address` matches an address label it builds from
    BOOK_PREFIX, so a book missing from that map genuinely cannot be addressed.
    The list is real — but it is written from the map instead of typed out
    beside it, so the description cannot promise a book the tool can't serve."""
    from shruti_chat.agent.tools import chunks_get_by_address  # noqa: F401
    from shruti_chat.agent.tools._helpers import BOOK_PREFIX
    from shruti_chat.agent.tools._registry import all_tools

    desc = all_tools()["chunks_get_by_address"].parameters["properties"]["book"][
        "description"
    ]
    for code in BOOK_PREFIX:
        assert code in desc, f"{code} is addressable but undocumented"
    assert "Śikṣāṣṭaka" not in desc


def test_the_schema_the_model_sees_defines_no_field_names_of_its_own() -> None:
    """A pydantic docstring becomes the JSON-schema description sent with the
    request, so it is a second prompt. It listed `source_id` for a while after
    the router prompt had moved to `source`, and the model — hearing both —
    kept answering with the retired key even against the new instruction."""
    from shruti_chat.domain.routing import RoutingDecision

    desc = RoutingDecision.model_json_schema().get("description", "")
    assert "source_id" not in desc
    # The prompt is the only place that names the fields; if this docstring
    # starts enumerating them again the two will drift exactly as they did.
    for retired in ("doc_date_from", "content_types", "anniversary_md"):
        assert retired not in desc
