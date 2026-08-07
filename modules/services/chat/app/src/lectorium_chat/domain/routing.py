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
    "find_track",       # lecture search — semantic (topic) + metadata filters → ranked cards + why-quote
    "recommend",        # personal "what to listen next" — topic-affinity from history
    "show_verse",       # a bare scripture reference ("БГ 2.13") — fetch + show that verse
    "create_action",    # user wants to create something (playlist, PDF, reminder)
    "add-to-library",   # PRO: find an external lecture (YouTube/web) and add it to the personal library
    "unknown",          # ambiguous or out-of-scope; soft fallback to synthesizer
]


# NOTE — this class's docstring is not documentation, it is prompt: pydantic
# puts it in the JSON-schema description that travels with every structured
# request, so the model reads it alongside the router prompt. It used to list
# the extracted-arg keys, and kept advertising `source_id` after the prompt had
# moved to `source` — the model heard both and sometimes answered with the
# retired one, which is why «Шикшаштака» was still being mapped to a book after
# the prompt said not to. Field names belong in exactly one place: the prompt.
class RoutingDecision(BaseModel):
    """Router output.

    `confidence` is the model's own certainty in `intent`; below 0.5 the
    classification is treated as unsure downstream.

    `extracted_args` carries whatever the router prompt asks it to extract for
    this turn. Deliberately unconstrained: a worker takes what it recognizes
    and ignores the rest.
    """

    model_config = ConfigDict(extra="ignore")

    intent: Intent
    confidence: float = Field(ge=0.0, le=1.0)
    extracted_args: dict[str, Any] = Field(default_factory=dict)
