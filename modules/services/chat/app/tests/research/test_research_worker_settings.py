"""The research worker hands the pipeline the turn's configured knobs.

`run_research` and `resolve_retrieval_lang` default to a DB ceiling of 8 and
an en+ru fallback. A worker that forgot to pass `ctx.settings` would run every
turn at those defaults — oversubscribing a pool tuned below 8, or clamping to a
language the deployment does not index — and no other test would notice.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from shruti_chat.agent.graph.nodes import research_worker
from shruti_chat.agent.graph.turn_context import TurnContext, TurnSettings
from shruti_chat.domain.name_matching import NameMatcher


class _Stop(Exception):
    pass


async def test_the_pipeline_gets_the_turns_ceiling_and_languages(monkeypatch) -> None:
    seen: dict[str, Any] = {}

    async def _retrieval_lang(_repo, _lang, *, request_id=None, fallback_langs=()):  # noqa: ARG001
        seen["fallback_langs"] = tuple(fallback_langs)
        return "en"

    async def _run_research(**kwargs: Any):
        seen["fanout_db_concurrency"] = kwargs.get("fanout_db_concurrency")
        raise _Stop

    async def _owned(_ctx) -> list[str]:
        return []

    monkeypatch.setattr(research_worker, "resolve_retrieval_lang", _retrieval_lang)
    monkeypatch.setattr(research_worker, "run_research", _run_research)
    monkeypatch.setattr(research_worker, "owned_track_ids", _owned)
    monkeypatch.setattr(research_worker, "get_stream_writer", lambda: lambda _ev: None)

    ctx = TurnContext(
        name_matcher=NameMatcher(()),
        request_id="r-knobs",
        chunk_repo=object(),
        embedder=object(),
        settings=TurnSettings(fanout_db_concurrency=3, corpus_langs=("en", "uk")),
    )
    state = {"user_query": "q", "lang": "en", "extracted_args": {}, "config": {}}
    with pytest.raises(_Stop):
        await research_worker.research_worker_node(state, SimpleNamespace(context=ctx))

    assert seen == {"fallback_langs": ("en", "uk"), "fanout_db_concurrency": 3}
