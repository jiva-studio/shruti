"""System prompt for the Lectorium chat agent — assembled from .md sections.

Each section is a separate file so future edits diff at the section
level instead of one monolith. Section order matters — it determines
the order the model reads the rules.

Each section is pulled from Langfuse via `prompt_with_fallback` so an
editor can iterate from the UI without a deploy. The fallback path
reads the bundled `.md` file (still shipped in the repo); that's also
what runs in eval mode (`LANGFUSE_FORCE_FALLBACK=1`) and during a
Langfuse outage.

Per-node section subsets live with the node:
- router       → `chat-router` standalone, fetched in `router_turn.py`.
- workers      → `WORKER_PROMPT_SECTIONS` in `agent/graph/nodes/_worker_common.py`.
- synthesizer  → `_SYNTH_PROMPT_SECTIONS` in `agent/graph/nodes/synthesizer.py`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

from lectorium_chat.observability.langfuse_client import prompt_with_fallback


def _section_to_langfuse_name(name: str) -> str:
    """`header` → `chat-section-header`. Bootstrap script publishes
    each section under this exact prefix."""
    return f"chat-section-{name}"


def build_prompt(
    sections: Iterable[str],
    *,
    lang: str | None = None,
    lang_name: str | None = None,
) -> str:
    """Assemble the system prompt from the named sections in order.

    `lang` (when provided) substitutes the `{{LANG}}` placeholder in
    any section that carries it (currently `language.md`). The
    placeholder lets us put the language directive ONCE in a prompt
    section instead of prepending `[lang=ru]` to every user message.

    Section order matters — it determines the order the model reads
    the rules — so the iterator MUST be deterministic. Section
    subsets at the call site MUST be tuples for that reason.
    """
    base = Path(__file__).parent
    parts: list[str] = []
    for name in sections:
        md_path = base / f"{name}.md"

        def _fallback(p: Path = md_path) -> str:
            # Bound the closure to a specific path — `name` would
            # otherwise rebind on each iteration and every fallback
            # would read the last section.
            return p.read_text(encoding="utf-8")

        prompt = prompt_with_fallback(
            _section_to_langfuse_name(name),
            fallback=_fallback,
        )
        parts.append(prompt.text)
    text = "".join(parts)
    if lang:
        # `{{LANG_NAME}}` = the human language name from the catalog `languages`
        # table (e.g. "Srpski", "Español", "हिन्दी"), passed by the caller — a
        # bare code ("sr-Latn") makes the LLM drift (it answered Russian). The
        # table is our single source of truth and auto-extends with new
        # languages, so nothing here needs maintaining. Falls back to the code
        # when no name was resolved. `{{LANG}}` stays the raw code for places
        # that need it (retrieval-lang matching, transliteration script hints).
        text = text.replace("{{LANG_NAME}}", lang_name or lang)
        text = text.replace("{{LANG}}", lang)
    return text


def standalone_prompt(name: str, md: str) -> str:
    """Text of a one-off prompt that is NOT a section of the system prompt.

    Same contract as `build_prompt`: Langfuse is the source of truth so an
    editor can tune the wording without a deploy, and the bundled `.md` is the
    fallback (Langfuse down, `LANGFUSE_FORCE_FALLBACK=1`, eval mode). Exists so
    a small prompt does not end up as a Python string literal — the one place
    nobody can edit and nobody thinks to look.

    `name` is the Langfuse prompt name, `md` the bundled file under this
    package (without `.md`). Both are listed in
    `scripts/bootstrap_langfuse_prompts.py`.
    """
    path = Path(__file__).parent / f"{md}.md"
    return prompt_with_fallback(
        name, fallback=lambda: path.read_text(encoding="utf-8"),
    ).text
