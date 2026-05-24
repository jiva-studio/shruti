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
        text = text.replace("{{LANG}}", lang)
    return text
