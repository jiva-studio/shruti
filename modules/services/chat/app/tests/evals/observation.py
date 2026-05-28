"""Captured-turn data for the multi-agent eval harness.

Before the migration the eval runner observed a single tool call and
its result. The new graph runs multiple stages (router → worker(s) →
synthesizer), so we need a richer record:

- which intent the router picked
- which tools the worker(s) called, in order, with args + results
- the synthesizer's final response text (for marker / phrase checks)

This module is pure data + parsing — no graph driving. The runner
builds a `TurnObservation` by subscribing to the graph's astream
events; tests construct it directly to exercise the predicate logic.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class ToolInvocation:
    name: str
    args: dict[str, Any]
    result: Any


@dataclass
class TurnObservation:
    """Everything a single chat turn produced that the eval cares about."""

    # Router decision (None if router didn't run, e.g. legacy monolith).
    intent: str | None = None
    confidence: float | None = None
    # Tool calls in dispatch order (across all workers in chain).
    # Kept for legacy cases that still assert tool-level behaviour
    # (catalog / action / help flows); research flow uses pipeline
    # outline observations below instead.
    tool_chain: list[ToolInvocation] = field(default_factory=list)
    # The synthesizer's final prose (post-MarkerExpander expansion —
    # this is what the client sees, including `[cite:track_X@...]`
    # marker shapes).
    response_text: str = ""
    # Outline-shape captured from `synthesis_planner_node`'s one-shot
    # `outline_summary` custom event. All None when the synthesis
    # planner didn't run (direct_chat / action / help flows). Eval
    # predicates assert outline structure via these.
    outline_n_theses: int | None = None
    outline_has_intro: bool | None = None
    outline_has_conclusion: bool | None = None
    outline_skipped_notes_ratio: float | None = None

    @property
    def first_tool(self) -> ToolInvocation | None:
        return self.tool_chain[0] if self.tool_chain else None

    @property
    def tool_names(self) -> list[str]:
        return [t.name for t in self.tool_chain]


# ── Marker parsing in the synthesizer's response text ────────────────────


_MARKER_RE = re.compile(r"\[([a-z_]+):([^\]\n]+)\]")


def parse_markers(response_text: str) -> list[tuple[str, str]]:
    """Return `[(kind, body), ...]` for every chip-class marker in the
    response. Both expanded and integer-ref forms are matched — eval
    cases that want to detect "no cite marker" don't care about the
    body, just the kind.
    """
    return [(m.group(1), m.group(2)) for m in _MARKER_RE.finditer(response_text)]


def has_marker_kind(response_text: str, kind: str) -> bool:
    """True if at least one marker of the given kind appears."""
    return any(k == kind for k, _ in parse_markers(response_text))


def has_blockquote(response_text: str) -> bool:
    """True if the response contains a markdown blockquote (used to
    verify commentary/letter/prose are quoted inline per the citation
    discipline)."""
    return any(line.lstrip().startswith(">") for line in response_text.splitlines())
