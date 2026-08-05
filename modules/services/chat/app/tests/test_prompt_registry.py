"""The prompt registry must cover exactly what the code can fetch.

Every prompt fetch supplies a bundled `.md` as its fallback — that is the
contract of `prompt_with_fallback`. So the set of `.md` files IS the set of
prompts that can be fetched, and the registry has to be a bijection with it.

Before the registry there were three lists and they had drifted:

  publisher (`_PROMPTS`)          23 names
  boot warm-up                    17 names, one of them renamed away
  what the code actually fetches  28 names

The five in neither published list still got fetched, so each 404'd, logged,
and fell back — with no negative cache on that path. `lecture-authors` runs
alongside the router on every single message, so it paid a failed round-trip
per message indefinitely.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from lectorium_chat.agent.prompts.registry import (
    PROMPT_DIR,
    PROMPTS,
    LANGFUSE_PROMPT_NAMES,
    spec_for,
)


def _bundled_md() -> set[str]:
    return {p.stem for p in PROMPT_DIR.glob("*.md")}


def test_every_bundled_prompt_is_registered() -> None:
    """A `.md` with no entry is a prompt the code can fetch and nothing
    publishes — exactly the state `lecture-authors` was in."""
    registered = {p.md for p in PROMPTS}
    assert _bundled_md() - registered == set()


def test_every_registered_prompt_has_its_fallback() -> None:
    """An entry with no `.md` publishes fine and then explodes the moment
    Langfuse is unreachable, which is the one time the fallback matters."""
    missing = [p.name for p in PROMPTS if not p.path.exists()]
    assert missing == []


def test_names_are_unique() -> None:
    names = [p.name for p in PROMPTS]
    assert len(names) == len(set(names))


def test_warm_up_covers_the_whole_registry() -> None:
    """A prompt outside the warm-up list pays a network fetch on the hot path
    for the first turn after every deploy."""
    assert set(LANGFUSE_PROMPT_NAMES) == {p.name for p in PROMPTS}


def test_publisher_reads_the_registry() -> None:
    """The bootstrap script must not carry its own copy of the table — that
    duplication is what drifted."""
    script = Path(__file__).resolve().parents[2] / "scripts" / "bootstrap_langfuse_prompts.py"
    tree = ast.parse(script.read_text())
    table = next(
        n.value
        for n in ast.walk(tree)
        if isinstance(n, ast.AnnAssign) and getattr(n.target, "id", "") == "_PROMPTS"
    )
    # A comprehension over PROMPTS, not a literal list of tuples.
    assert isinstance(table, ast.ListComp), "publisher still hardcodes the table"


@pytest.mark.parametrize(
    "name",
    [
        # Fetched on every message alongside the router.
        "lecture-authors",
        # Fetched on every follow-up turn.
        "chat-followup-rewrite",
        # Section swaps the synthesizer makes at runtime.
        "chat-section-fallback",
        "chat-section-out_of_scope",
        "chat-section-show_verse",
    ],
)
def test_the_previously_unpublished_prompts_are_registered(name: str) -> None:
    assert spec_for(name) is not None


def test_renamed_section_is_gone() -> None:
    """`chat-section-library` was renamed to `chat-section-note_types`; the
    stale name sat in the warm-up list and logged a miss on every boot."""
    assert spec_for("chat-section-library") is None
    assert spec_for("chat-section-note_types") is not None


def test_registry_import_does_not_cycle() -> None:
    """`agent/prompts/__init__` imports `prompt_with_fallback` from
    `langfuse_client`, so `langfuse_client` must not import the registry back —
    that cycle only breaks under some import orders, which is the worst kind:
    the full suite stayed green while importing `openrouter` first blew up."""
    import subprocess
    import sys
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "src"
    for first in (
        "lectorium_chat.infra.llm_provider.openrouter",
        "lectorium_chat.observability.langfuse_client",
        "lectorium_chat.agent.prompts",
    ):
        proc = subprocess.run(
            [sys.executable, "-c", f"import sys; sys.path.insert(0, {str(src)!r}); import {first}"],
            capture_output=True,
        )
        assert proc.returncode == 0, f"importing {first} first fails:\n{proc.stderr.decode()[-800:]}"
