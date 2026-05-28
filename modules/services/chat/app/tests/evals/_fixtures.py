"""Live chat-client fixture for the eval runner.

Mirrors `main.py:lifespan` minus the FastAPI scaffolding: it brings up
the full composition (Postgres pool, embedder, repos, tools, graph,
LLM) and exposes `observe_turn(query)` that returns a populated
`TurnObservation` for `evaluate_case` in `run_chunk_tools_eval`.

Run requires the same env the service does in production:
- OPENROUTER_API_KEY
- DATABASE_URL (Postgres with pgvector + indexed chunks)
- AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (for S3 transcripts/PDFs)
- CATALOG_DIR (where catalog.db + library.db live)

For the script in run_chunk_tools_eval.run_eval, this fixture is
constructed once and reused across all cases. Each `observe_turn`
call creates a fresh `TurnContext` so per-turn state (aliases,
expander) doesn't bleed between cases.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from lectorium_chat.agent import llm as legacy_llm
from lectorium_chat.agent.aliased_tools import build_aliased_tools
from lectorium_chat.agent.graph import build_chat_graph
from lectorium_chat.agent.marker_expander import MarkerExpander
from lectorium_chat.agent.tools import TOOLS, bind_repositories, build_personalized_tools
from lectorium_chat.agent.turn_aliases import TurnAliasMap
from lectorium_chat.config import get_settings
from lectorium_chat.db.client import get_pool, init_pool
from lectorium_chat.db.assert_schema import assert_schema_ready
from lectorium_chat.domain.turn_context import TurnContext
from lectorium_chat.domain.user_context import FocusFragment, UserContext, UserContextTrack
from lectorium_chat.indexer.embed import get_embedder
from lectorium_chat.infra.llm_provider import OpenRouterLLMProvider
from lectorium_chat.infra.repositories.embedding_router import EmbeddingTableRouter
from lectorium_chat.infra.repositories.pg_chunk_repository import PgChunkRepository
from lectorium_chat.infra.repositories.sqlite_catalog_repository import (
    SqliteCatalogRepository,
)
from lectorium_chat.infra.storage.s3_outline_cache import S3OutlineCache
from lectorium_chat.infra.storage.s3_pdf_storage import S3PdfStorage
from lectorium_chat.infra.storage.s3_transcript_storage import S3TranscriptStorage
from lectorium_chat.observability.logging import setup_logging
from tests.evals.observation import TurnObservation
from tests.evals.observer import install_capture_processor, observe_turn


@dataclass
class EvalChatClient:
    """Singleton-per-process eval client. Holds the compiled graph +
    bound tools; `observe_turn` builds a fresh TurnContext per call.

    Carries one synthetic UserContext seed (`_seed_track_id` etc.)
    chosen at startup from a real lecture chunk in the local DB. Cases
    that declare `context.focus_ref="auto"` or `current_track_ref="auto"`
    or `recent_tracks="auto"` get a UserContext populated from the seed.
    """

    graph: Any
    llm: Any
    library_db_path: Any
    # Seed: a real (track_id, start_ms, end_ms) from the local pgvector
    # used to synthesize FocusFragment / current_track / fake history
    # for cases that need user state.
    _seed_track_id: str = ""
    _seed_start_ms: int = 0
    _seed_end_ms: int = 0

    def _build_user_context(
        self, context: dict[str, Any] | None
    ) -> UserContext | None:
        """Translate a JSONL `context` block into a UserContext suitable
        for the harness. Supported keys:
        - focus_ref=auto         → FocusFragment from the seed chunk
        - current_track_ref=auto → current_track_id from the seed track
        - recent_tracks=auto     → seed_track in recent history (50% played)
        Anything else is ignored (cases can carry doc strings).
        """
        if not context:
            return None
        if not self._seed_track_id:
            return None

        focus = None
        if context.get("focus_ref") == "auto":
            focus = FocusFragment(
                track_id=self._seed_track_id,
                start_ms=self._seed_start_ms,
                end_ms=self._seed_end_ms,
                title="seeded fragment",
            )
        current_track_id = None
        if context.get("current_track_ref") == "auto":
            current_track_id = self._seed_track_id
        # Synthesize a "yesterday" timestamp so user_tracks_list can
        # apply since/until bounds against `now`. Without this the LLM
        # has no way to compute a date window.
        now = datetime.now(tz=timezone.utc)
        recent: tuple[UserContextTrack, ...] = ()
        if context.get("recent_tracks") == "auto":
            recent = (
                UserContextTrack(
                    track_id=self._seed_track_id,
                    percent=0.42,
                    position_ms=self._seed_start_ms,
                    last_played_at=now - timedelta(hours=18),
                ),
            )
        if focus is None and current_track_id is None and not recent:
            return None
        return UserContext(
            current_track_id=current_track_id,
            focus=focus,
            recent_tracks=recent,
            now=now,
        )

    async def observe_turn(
        self, query: str, context: dict[str, Any] | None = None,
        *, lang: str = "ru",
    ) -> TurnObservation:
        """Drive one turn through the live graph; return the observation
        the predicates check against.

        `lang` is the chat interface language for THIS turn — pass it
        from the JSONL case's `lang` field. Production reads the mobile
        client's UI language; in eval we set it per-case so EN queries
        get EN tool filtering and don't miss the half of the corpus
        that's in their language.
        """
        user_ctx = self._build_user_context(context)
        aliases = TurnAliasMap()
        # Pre-mint refs and capture the integers — workers' system
        # prompts surface them via the user-context anchors block
        # (same plumbing chat_turn.py does in production).
        current_track_ref: int | None = None
        focus_ref: int | None = None
        focus_around_ms: int | None = None
        now_iso: str | None = None
        history_summary: str | None = None
        if user_ctx is not None:
            if user_ctx.current_track_id:
                current_track_ref = aliases.alias_track(user_ctx.current_track_id)
            if user_ctx.focus is not None:
                focus_ref = aliases.alias_chunk(
                    user_ctx.focus.track_id,
                    user_ctx.focus.start_ms,
                    user_ctx.focus.end_ms,
                )
                focus_around_ms = (
                    user_ctx.focus.start_ms + user_ctx.focus.end_ms
                ) // 2
            if user_ctx.now is not None:
                now_iso = user_ctx.now.isoformat()
            if user_ctx.recent_tracks:
                in_prog = len(user_ctx.in_progress_tracks())
                history_summary = (
                    f"recent={len(user_ctx.recent_tracks)} "
                    f"in_progress={in_prog}"
                )
        expander = MarkerExpander(aliases)
        # Build the full aliased bag once, then slice into per-worker
        # subsets — must mirror what chat_turn.py does in prod, or the
        # workers see empty tool dicts and the LLM has nothing to call.
        from lectorium_chat.application.chat_turn import (
            _ACTION_TOOL_NAMES,
            _CATALOG_TOOL_NAMES,
            _HELP_TOOL_NAMES,
            _RESEARCH_TOOL_NAMES,
            _subset,
        )
        all_aliased = build_aliased_tools(
            build_personalized_tools(TOOLS, user_ctx), aliases
        )
        base_ctx = TurnContext(
            request_id="eval",
            aliases=aliases,
            expander=expander,
            llm=self.llm,
            research_tools=_subset(all_aliased, _RESEARCH_TOOL_NAMES),
            catalog_tools=_subset(all_aliased, _CATALOG_TOOL_NAMES),
            action_tools=_subset(all_aliased, _ACTION_TOOL_NAMES),
            help_tools=_subset(all_aliased, _HELP_TOOL_NAMES),
            library_db_path=self.library_db_path,
        )
        return await observe_turn(
            query,
            graph=self.graph,
            base_ctx=base_ctx,
            lang=lang,
            focus_ref=focus_ref,
            focus_around_ms=focus_around_ms,
            current_track_ref=current_track_ref,
            now_iso=now_iso,
            history_summary=history_summary,
        )


_client_cache: EvalChatClient | None = None


async def _build_once() -> EvalChatClient:
    """Run the equivalent of main.py:lifespan once and cache the
    composed services. Idempotent across multiple eval runs in the
    same process."""
    global _client_cache
    if _client_cache is not None:
        return _client_cache

    setup_logging()
    # setup_logging reconfigures structlog with its own processor list;
    # re-install the capture processor so router_decision / tool_call
    # events feed into the observer's per-turn buffer.
    install_capture_processor()
    s = get_settings()

    pool = await init_pool(s)
    # Evals expect the central migrator to have already applied the schema
    # (CI/dev should `docker compose up migrator` before running evals).
    # assert_schema_ready exits 1 if not — better than running evals
    # against an empty DB and getting cryptic asyncpg errors.
    await assert_schema_ready()
    legacy_llm.configure_providers(s)
    embedder = get_embedder(s)

    chunk_repo = PgChunkRepository(
        pool=pool,
        embed_model=embedder.name,
        router=EmbeddingTableRouter(dim=s.embed_dim),
    )
    catalog_repo = SqliteCatalogRepository(catalog_db_path=s.catalog_db_path)
    transcript_storage = S3TranscriptStorage(settings=s)
    outline_cache = S3OutlineCache(settings=s)
    pdf_storage = S3PdfStorage(settings=s)

    bind_repositories(
        chunk_repo=chunk_repo,
        catalog_repo=catalog_repo,
        transcript_storage=transcript_storage,
        outline_cache=outline_cache,
        pdf_storage=pdf_storage,
        embedder=embedder,
    )

    llm_provider = OpenRouterLLMProvider(s)
    graph = build_chat_graph()

    # Pick a real (track_id, start_ms, end_ms) from the local pgvector
    # to seed user-context cases. Any russian-lang transcript chunk
    # works — the LLM only needs a valid focus to call
    # chunks_get_window / chunks_find_similar against.
    seed_track_id, seed_start, seed_end = "", 0, 0
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT track_id, start_ms, end_ms FROM chunks "
            "WHERE kind='track_transcript' AND lang='ru' "
            "LIMIT 1"
        )
    if row is not None:
        seed_track_id = row["track_id"]
        seed_start = int(row["start_ms"] or 0)
        seed_end = int(row["end_ms"] or 0)

    _client_cache = EvalChatClient(
        graph=graph,
        llm=llm_provider,
        library_db_path=s.library_db_path,
        _seed_track_id=seed_track_id,
        _seed_start_ms=seed_start,
        _seed_end_ms=seed_end,
    )
    return _client_cache


# The runner imports this synchronously. We expose an async factory
# that returns the client; the runner's `run_eval` is already async,
# so it can await it.
#
# When `EVAL_TARGET_URL` env var is set, the factory returns an
# HTTP-backed client that talks to a DEPLOYED chat instance over
# HTTPS+SSE — used for prod-regression eval without spinning up a
# local DB. Without the env var, falls back to the in-process
# `EvalChatClient` (requires local pgvector / OpenRouter etc.).
def make_chat_client() -> Any:
    import os
    target = os.getenv("EVAL_TARGET_URL", "").strip().rstrip("/")
    if target:
        # Deferred import — HttpChatClient is in its own thin module
        # so the in-process pathway's heavy deps (Postgres, S3, etc.)
        # don't get pulled when we just want to hit a deployed instance.
        from tests.evals._http_client import HttpChatClient
        return HttpChatClient(target)
    return _ClientFactory()


class _ClientFactory:
    """Tiny façade so the runner can `await chat_client._ensure().observe_turn(...)`
    via the existing `chat_client.observe_turn(...)` shape — we shim
    the lazy build behind a property/await."""

    _inner: EvalChatClient | None = None

    async def _ensure(self) -> EvalChatClient:
        if self._inner is None:
            self._inner = await _build_once()
        return self._inner

    async def observe_turn(
        self, query: str, context: dict[str, Any] | None = None,
        *, lang: str = "ru",
    ) -> TurnObservation:
        client = await self._ensure()
        return await client.observe_turn(query, context=context, lang=lang)


# `HttpChatClient` is imported lazily from `_http_client.py` inside
# `make_chat_client` so the in-process pathway (which needs Postgres,
# OpenRouter, S3 — see imports at top of this file) doesn't get
# triggered when the runner only wants the HTTP target.
