"""Deterministic classifier chain — tried before the LLM router.

Each `Classifier` inspects the raw query and either claims it (returns a
`RoutingDecision`) or passes (`None`). They run in order; the first
non-None wins. The LLM router is the LAST link (wired in `router_node`),
so the chain only short-circuits the LLM for queries a cheap, exact rule
handles with high precision — everything else falls through unchanged.

This is the place to register new deterministic rules (e.g. the
create_action token rule currently baked into the router prompt) so they
stop loading the LLM and stop depending on a Langfuse prompt deploy.
"""

from __future__ import annotations

from typing import Any, Protocol

from lectorium_chat.domain.routing import RoutingDecision


class ClassifierContext(Protocol):
    """The per-turn dependencies a classifier may read.

    A structural protocol owned by the classify layer — the graph's
    `TurnContext` satisfies it by duck typing, so dependencies flow strictly
    graph → classify and never the reverse (no graph import here, which is
    what created the import cycle).
    """

    lang: str
    catalog_repo: Any
    library_repo: Any


class Classifier(Protocol):
    """A single deterministic classification rule.

    `classify` returns a `RoutingDecision` to claim the turn, or `None`
    to let the next classifier (ultimately the LLM router) handle it.
    Must never raise on a normal miss — return `None` instead.
    """

    name: str

    async def classify(
        self, query: str, ctx: ClassifierContext
    ) -> RoutingDecision | None: ...


async def run_classifier_chain(
    classifiers: list[Classifier], query: str, ctx: ClassifierContext
) -> RoutingDecision | None:
    """Run classifiers in order; return the first non-None decision.

    A classifier that raises is treated as a miss (logged by the caller
    via the returned None path) so one buggy rule can never break routing.
    """
    for clf in classifiers:
        try:
            decision = await clf.classify(query, ctx)
        except Exception:  # noqa: BLE001 — a rule miss must never break routing
            decision = None
        if decision is not None:
            return decision
    return None
