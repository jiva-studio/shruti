"""`run_chat_turn` hands the graph the deployment's configuration and the
composition root's collaborators, not the `TurnContext` defaults.

Those defaults exist for tests that build a context by hand: `TurnSettings()`
is an unconfigured deployment and `NameMatcher(())` knows no naming convention.
A turn that fell back to either would run with the wrong models, the wrong
fanout ceiling and the wrong corpus languages, or read "Srila Prabhupada" as
absent from the corpus — with nothing failing loudly.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock, patch

from shruti_chat.agent.graph.turn_context import TurnSettings
from shruti_chat.application import chat_turn
from shruti_chat.application.chat_turn import run_chat_turn
from shruti_chat.application.chat_turn_request import ChatTurnRequest
from shruti_chat.composition import build_name_matcher


class _GraphCapturingContext:
    def __init__(self) -> None:
        self.context: Any = None

    async def astream(self, _state, *, context, stream_mode):  # noqa: ARG002
        self.context = context
        yield ("custom", {"type": "delta", "data": {"text": "ok"}})


@dataclass
class _ConfiguredSettings:
    # Every knob differs from the `TurnSettings` default.
    library_db_path: str = "/tmp/x.db"
    embed_model: str = "fake-embed"
    embed_dim: int = 1536
    llm_cheap: str = "deploy/cheap"
    llm_fallback_knowledge: str = "deploy/knowledge"
    media_base_url: str = "https://cdn.deploy.example"
    enable_corpus_fallback: bool = False
    fanout_db_concurrency: int = 3
    langs: tuple[str, ...] = ("en", "uk")


@dataclass
class _Deps:
    settings: _ConfiguredSettings
    chat_graph: Any
    llm: Any
    embedder: Any = None
    chunk_repo: Any = None
    catalog_repo: Any = None
    pool: Any = None
    memo_cache: Any = field(default_factory=MagicMock)
    reranker: Any = None
    name_matcher: Any = field(default_factory=build_name_matcher)
    library_repo: Any = None
    translation_service: Any = None
    lecture_search: Any = None


@asynccontextmanager
async def _no_trace(*_a, **_k):
    yield None


async def _context_of_one_turn(deps: _Deps) -> Any:
    with patch.object(chat_turn, "get_langfuse", return_value=None), \
         patch.object(chat_turn, "with_langfuse_trace", _no_trace):
        async for _ in run_chat_turn(
            ChatTurnRequest(
                history=[{"role": "user", "content": "hi"}],
                lang="en", request_id="r-wiring-1",
            ),
            deps=deps,
        ):
            pass
    return deps.chat_graph.context


async def test_the_turn_reads_the_deployment_settings_not_the_defaults() -> None:
    deps = _Deps(settings=_ConfiguredSettings(), chat_graph=_GraphCapturingContext(), llm=MagicMock())
    ctx = await _context_of_one_turn(deps)
    assert ctx.settings == TurnSettings(
        llm_cheap="deploy/cheap",
        llm_fallback_knowledge="deploy/knowledge",
        media_base_url="https://cdn.deploy.example",
        enable_corpus_fallback=False,
        fanout_db_concurrency=3,
        corpus_langs=("en", "uk"),
    )


async def test_the_turn_carries_the_composition_roots_collaborators() -> None:
    deps = _Deps(settings=_ConfiguredSettings(), chat_graph=_GraphCapturingContext(), llm=MagicMock())
    ctx = await _context_of_one_turn(deps)
    assert ctx.name_matcher is deps.name_matcher
    assert ctx.memo_cache is deps.memo_cache
