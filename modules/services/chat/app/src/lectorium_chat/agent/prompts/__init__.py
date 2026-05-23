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

from lectorium_chat.observability.langfuse_client import prompt_with_fallback


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


def _section_to_langfuse_name(name: str) -> str:
    """`header` → `chat-section-header`. Bootstrap script publishes
    each section under this exact prefix."""
    return f"chat-section-{name}"


def build_prompt(sections: Iterable[str] = _SECTIONS) -> str:
    """Assemble the system prompt from the named sections in order.

    Each section is pulled from Langfuse with `prompt_with_fallback`
    so an editor can iterate on `quoting` or `library` from the UI
    without a deploy. The fallback path reads the bundled `.md`
    file (still shipped in the repo) — that's also what runs in eval
    mode (`LANGFUSE_FORCE_FALLBACK=1`) and during a Langfuse outage.

    Section order matters — it determines the order the model reads
    the rules — so the iterator MUST be deterministic. The default
    `_SECTIONS` is a tuple for that reason.
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
    return "".join(parts)


# NB: `SYSTEM_PROMPT` (the full assembly) was previously evaluated at
# import time. That broke hot-reload — once imported, every later
# `get_prompt` would have been bypassed. We now build per-call inside
# `build_prompt`. Callers that still want the legacy export should
# invoke `build_prompt()` themselves; nothing in-tree does, so we
# don't export the stale name any more.

