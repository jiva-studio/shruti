"""Boot the real FastAPI lifespan end to end, with only the network edges faked.

Every route test builds `AppDeps` by hand (see `conftest.build_deps`), so the
composition code in `main.lifespan` — the one path every deploy runs first — is
otherwise executed by nothing but a container start. A call to a function that
does not exist passes the whole suite and crashes the service at boot.

What is faked is exactly what needs a live peer: the Postgres pool and the
schema probe, the embedding client, the LLM provider configuration, the
indexer's scheduler loop and its bootstrap. Redis clients connect lazily, so
the real adapters are built against an address nothing listens on and are
never dialled. Langfuse runs in its fallback mode (`LANGFUSE_FORCE_FALLBACK`,
set for every test by `conftest`).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI

import shruti_chat.main as main_mod
from shruti_chat.composition import AppDeps
from shruti_chat.domain.cache_versions import embed_model_tag

_DB_STATE = [
    {"kind": "catalog", "current_version": "20260920"},
    {"kind": "library", "current_version": "20260918"},
    {"kind": "unrelated", "current_version": "999"},
]

_BOOT_TIMEOUT_S = 30.0


class _FakeConn:
    def __init__(self, pool: "_FakePool") -> None:
        self._pool = pool

    async def fetch(self, query: str, *args: Any) -> list[dict[str, str]]:
        self._pool.queries.append(query)
        if "db_state" in query:
            return list(_DB_STATE)
        return []


class _FakePool:
    def __init__(self) -> None:
        self.queries: list[str] = []

    @asynccontextmanager
    async def acquire(self):
        yield _FakeConn(self)


class _FakeEmbedder:
    name = "fake-embedder"
    dim = 1536

    async def embed_query(self, text: str) -> list[float]:
        return [0.0] * self.dim

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [[0.0] * self.dim for _ in texts]


@pytest.fixture
def boot_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Settings a production container would carry, pointed at throwaway paths."""
    key = tmp_path / "public.pem"
    key.write_text("-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----\n")
    env = {
        "REDIS_URL": "redis://127.0.0.1:1/0",
        "OPENROUTER_API_KEY": "sk-test-not-a-key",
        "JWT_PUBLIC_KEY_PATH": str(key),
        "CATALOG_DIR": str(tmp_path / "catalog"),
        "INDEXER_BOOTSTRAP_ON_START": "false",
        "EMBED_PROVIDER": "openai",
        "EMBED_MODEL": "text-embedding-3-small",
        "EMBED_DIM": "1536",
    }
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    (tmp_path / "catalog").mkdir()

    pool = _FakePool()
    calls: dict[str, Any] = {"pool": pool, "closed_pool": 0}

    async def fake_init_pool(settings: Any) -> _FakePool:
        return pool

    async def fake_close_pool() -> None:
        calls["closed_pool"] += 1

    async def fake_assert_schema_ready() -> None:
        return None

    async def fake_scheduler_loop(
        settings: Any, *, stop_event: asyncio.Event, cache_versions: Any,
    ) -> None:
        await stop_event.wait()

    monkeypatch.setattr(main_mod, "setup_logging", lambda: None)
    monkeypatch.setattr(main_mod, "init_pool", fake_init_pool)
    monkeypatch.setattr(main_mod, "close_pool", fake_close_pool)
    monkeypatch.setattr(main_mod, "assert_schema_ready", fake_assert_schema_ready)
    monkeypatch.setattr(main_mod, "get_embedder", lambda settings: _FakeEmbedder())
    monkeypatch.setattr(main_mod.llm, "configure_providers", lambda settings: None)
    monkeypatch.setattr(main_mod.indexer_run, "scheduler_loop", fake_scheduler_loop)
    return calls


async def _boot_and_stop(app: FastAPI) -> AppDeps:
    async with main_mod.lifespan(app):
        assert isinstance(app.state.deps, AppDeps)
        return app.state.deps


async def test_lifespan_boots_and_shuts_down(boot_env: dict[str, Any]) -> None:
    app = FastAPI()
    await asyncio.wait_for(_boot_and_stop(app), timeout=_BOOT_TIMEOUT_S)

    assert boot_env["closed_pool"] == 1


async def test_lifespan_seeds_the_cache_version_tags(boot_env: dict[str, Any]) -> None:
    """The tags the KV cache keys on come from settings and `db_state`.

    Read through the memo cache on `AppDeps` as well — the object every cache
    key is built by — so a boot path that seeds some other registry fails here.
    """
    app = FastAPI()
    deps = await asyncio.wait_for(_boot_and_stop(app), timeout=_BOOT_TIMEOUT_S)

    tags = deps.cache_versions.snapshot()
    assert tags["embed_model"] == embed_model_tag("openai", "text-embedding-3-small", 1536)
    assert deps.memo_cache.make_key("pg_window", 1).startswith("lc:v1:pg_window:20260918-")
    assert tags["catalog"] == "20260920"
    assert tags["library"] == "20260918"
    assert "unrelated" not in tags
    assert any("db_state" in q for q in boot_env["pool"].queries)
