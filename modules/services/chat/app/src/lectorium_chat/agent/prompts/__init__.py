"""System prompt for the Lectorium chat agent — assembled from .md sections.

Each section is a separate file so future edits diff at the section level
instead of the 460-line monolith. Section order matters — it determines
the order the model reads the rules.

To edit one rule (e.g. citation discipline), edit `citations.md` only.

`SYSTEM_PROMPT` (the full assembly) stays for backward-compat with the
existing monolithic `chat_turn.py`. The multi-agent graph uses
`build_prompt(sections=...)` to give each node a tailored subset:
- router: empty (its prompt is hardcoded in `application/router_turn.py`)
- workers: `header + tools + quoting` (no citations — synth handles those)
- synthesizer: `header + citations + library + quoting + response_shape +
  language + safety + no_narration` (everything that shapes the final
  prose; no `tools` / `actions` since synth doesn't call tools)
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

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


def build_prompt(sections: Iterable[str] = _SECTIONS) -> str:
    """Assemble the system prompt from the named sections in order.

    Unknown section names raise `FileNotFoundError` — fail loudly so a
    typo in a node's section list is a startup error, not a silent
    half-prompt at runtime.
    """
    base = Path(__file__).parent
    return "".join((base / f"{name}.md").read_text() for name in sections)


SYSTEM_PROMPT = build_prompt()
