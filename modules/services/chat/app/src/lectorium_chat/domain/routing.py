"""RoutingDecision — output of the router node.

Lives in `domain/` because it crosses use-case boundaries:

- `router_node` produces it (via `LLMPort.structured_output`).
- `route_after_router` (the graph's conditional edge) reads `intent`
  to pick the next node.
- Worker nodes read `extracted_args` to seed their tool calls.

Pydantic BaseModel — not a dataclass — because the LLM emits it
through structured-output JSON validation. Optional fields default
empty so the model can omit fields it didn't extract.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# Intent enum is exposed as a Literal so type checkers can flow-narrow
# in `route_after_router`. Adding a new intent here is the single
# place that needs to change for routing to recognise it.
Intent = Literal[
    "direct_chat",      # greetings, thanks, meta-talk; no search needed
    "help",             # capability questions; routed to help_worker
    "research",         # search across lectures / verses / commentaries / letters
    "locate",           # WHERE in scripture is a topic/story — canto/chapter/verse address
    "find_track",       # catalog lookup by author/source/date — specific track or list
    "create_action",    # user wants to create something (playlist, PDF, reminder)
    "unknown",          # ambiguous or out-of-scope; soft fallback to synthesizer
]


class RoutingDecision(BaseModel):
    """Router output. `confidence` is the model's self-reported
    confidence in `intent`; we treat <0.5 as "unknown" downstream.

    `extracted_args` is a free-form bag of seed args (year, location,
    source_id, tokens, doc_date_from/to, content_types, kind, author).
    Workers MAY use them as hints; not all fields are present in every
    decision. Schema is intentionally loose — the model wins, we don't
    fight it on edge structures we didn't anticipate.
    """

    model_config = ConfigDict(extra="ignore")

    intent: Intent
    confidence: float = Field(ge=0.0, le=1.0)
    extracted_args: dict[str, Any] = Field(default_factory=dict)
