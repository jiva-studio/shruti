"""System prompt for the Lectorium chat agent — assembled from .md sections.

Each section is a separate file so future edits diff at the section level
instead of the 460-line monolith. Section order matters — it determines
the order the model reads the rules.

To edit one rule (e.g. citation discipline), edit `citations.md` only.
"""

from __future__ import annotations

from pathlib import Path

_SECTIONS = (
    "header",
    "tools",
    "actions",
    "followups",
    "no_narration",
    "citations",
    "library",
    "quoting",
    "response_shape",
    "language",
    "safety",
)


def _load() -> str:
    base = Path(__file__).parent
    return "".join((base / f"{name}.md").read_text() for name in _SECTIONS)


SYSTEM_PROMPT = _load()
