"""Shared test seams.

There was no root conftest. The consequences are measurable: ~32 hand-written
`FakeLLM` classes, 27 files carrying their own fake repositories, 138
`monkeypatch.setattr` sites reaching into module internals — and **zero** tests
constructing an `AppDeps`, the very thing `composition.py` documents as the
test seam:

    Replacing an adapter (e.g. for tests) means building an `AppDeps` instance
    with fake repos and stuffing it into `app.state.deps`.

Nobody could, because it has 13 required fields on a frozen slotted dataclass.
So tests built duck-typed doubles instead, and the production code adapted to
them: `chat_turn.py` reads two of its own dependencies through `getattr` with
a comment about "test doubles that predate this field". A missing seam had
started deforming the code it was meant to test.

This file is additive on purpose. Nothing here changes an existing test; the
fixtures are available for new ones and for migrating the duplicates as those
files are touched anyway. That ordering matters — the two structural refactors
that stalled (extracting the card layer, the provider-unavailable port) both
stalled on tests gripping module internals, not on the production change.
"""

from __future__ import annotations

import os
from typing import Any

import pytest


# ── hermetic configuration ────────────────────────────────────────────
#
# Importing `litellm` calls `load_dotenv()`, which walks up from the installed
# package and loads the first `.env` it finds. In a checkout that is the
# developer's service `.env` — 24 live names, among them the provider keys,
# `DATABASE_URL`, `APP_SHARED_TOKEN` and the tier caps. Environment variables
# outrank a model default, so the suite was asserting against dev config:
# `ip_rate_limit_per_day` 200 against a shipped 2000, `llm_default` a gemini
# model against the shipped deepseek one. CI was hermetic only by accident,
# because `.env` is gitignored.
#
# `litellm` is a transitive import of nearly every test and can land at any
# point of a session, so one scrub is not enough. Two moves instead: seal
# `load_dotenv` so nothing can inject later, and drop whatever an earlier
# import already injected. Both are independent of where the file happens to
# resolve from, so they hold in CI (no `.env` at all) and locally alike.

_HERMETIC_ENV_FILE = ".env.pytest-hermetic-never-exists"

# The one name the suite sets on itself, per test, by design — see
# `_no_langfuse_network` below. The hermeticity guards exempt it.
SUITE_ENV_OVERRIDES = frozenset({"LANGFUSE_FORCE_FALLBACK"})


def _settings_env_names() -> frozenset[str]:
    """The env var names `Settings` reads — field names, upper-cased.

    No `env_prefix` and no aliases in `config.py`, so the mapping is direct.
    """
    from shruti_chat.config import Settings

    return frozenset(name.upper() for name in Settings.model_fields)


def _seal_dotenv() -> None:
    """Turn `load_dotenv()` into a no-op for the rest of the process."""
    try:
        import dotenv
        import dotenv.main
    except ModuleNotFoundError:  # pragma: no cover — ships with litellm
        return

    def _refuse(*_args: Any, **_kwargs: Any) -> bool:
        return False

    dotenv.load_dotenv = _refuse
    dotenv.main.load_dotenv = _refuse


def _scrub_settings_env() -> list[str]:
    """Remove every `Settings` name from `os.environ`.

    Deliberately blunt: a name exported by the developer's shell contaminates
    the run exactly as much as one copied out of a dotenv file. Nothing the
    suite needs lives here — `SHRUTI_INTEGRATION_DB`, the one env var the
    integration gate reads, is not a `Settings` field.
    """
    removed = sorted(name for name in _settings_env_names() if name in os.environ)
    for name in removed:
        del os.environ[name]
    return removed


def _seal_settings_env_file() -> None:
    """Point the dotenv *file* source at a path that cannot exist.

    `Settings.model_config` names `.env` relative to the working directory, so
    running pytest from the service root rather than `app/` would read the dev
    file directly, bypassing the `os.environ` scrub. A non-existent name keeps
    `warn_unknown_env_keys()` — which reads this same key — working.
    """
    from shruti_chat.config import Settings

    Settings.model_config["env_file"] = _HERMETIC_ENV_FILE


def _make_hermetic() -> None:
    _seal_dotenv()
    _seal_settings_env_file()
    _scrub_settings_env()
    from shruti_chat import config as config_mod

    config_mod._settings = None


@pytest.fixture(scope="session", autouse=True)
def _hermetic_settings() -> None:
    """Re-assert hermeticity once collection is over.

    `pytest_configure` runs before any test module is imported, which is where
    most `litellm` imports happen; this catches anything that slipped in during
    collection (a module-scope `os.environ[...]`, an early plugin).
    """
    _make_hermetic()


# ── markers ───────────────────────────────────────────────────────────
#
# Gating is directory-based today: `tests/integration/conftest.py` skips
# everything under its own tree. That is why `tests/integration/test_xff.py` is
# skipped despite needing no infrastructure at all — it exercises uvicorn
# middleware in memory. Capability markers let a test say what it actually
# needs instead of being judged by where it lives.


def pytest_configure(config: pytest.Config) -> None:
    _make_hermetic()
    config.addinivalue_line(
        "markers", "needs_db: requires a real Postgres (see SHRUTI_INTEGRATION_DB)",
    )
    config.addinivalue_line(
        "markers", "needs_network: reaches a live service or model provider",
    )


# ── determinism ───────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _no_langfuse_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep prompt fetches off the network for every test.

    Without it a test that happens to touch the prompt path will try a real
    `get_prompt` if `LANGFUSE_*` is set in the developer's environment — the
    suite's hermeticity is currently a property of most people not having
    those vars, not of anything enforcing it.

    Set BEFORE `Settings` is read, and the config singleton is cleared so a
    previously-cached instance can't outvote it.
    """
    monkeypatch.setenv("LANGFUSE_FORCE_FALLBACK", "1")
    from shruti_chat import config as config_mod

    monkeypatch.setattr(config_mod, "_settings", None, raising=False)


# ── fakes ─────────────────────────────────────────────────────────────


class FakeTurnStore:
    """In-memory `TurnStore` mirroring the Redis adapter's contract.

    Re-implemented five times across the suite before this.
    """

    def __init__(self) -> None:
        self.records: dict[str, dict[str, Any]] = {}
        self.cancelled: set[str] = set()

    async def mark_running(self, trace_id: str, user_id: str) -> None:
        self.records[trace_id] = {"state": "running", "user_id": user_id}

    async def heartbeat(self, trace_id: str) -> None:
        return None

    async def finish(
        self, trace_id: str, *, state: str, events: list[Any], user_id: str
    ) -> None:
        self.records[trace_id] = {"state": state, "user_id": user_id, "events": events}

    async def get(self, trace_id: str) -> dict[str, Any] | None:
        return self.records.get(trace_id)

    async def request_cancel(self, trace_id: str) -> None:
        self.cancelled.add(trace_id)

    async def is_cancelled(self, trace_id: str) -> bool:
        return trace_id in self.cancelled


class FakeIdempotencyStore:
    """SET-NX-EX semantics, same degradation contract as the port."""

    def __init__(self) -> None:
        self.held: set[str] = set()

    async def try_acquire(self, key: str, ttl_seconds: int) -> bool:
        if key in self.held:
            return False
        self.held.add(key)
        return True

    async def release(self, key: str) -> None:
        self.held.discard(key)


class ScriptedLLM:
    """An `LLMPort` that returns queued answers and records what it was asked.

    Every scripted-LLM double in the suite is a variation on this; the point of
    having one is that a change to the port surface breaks in one place.
    """

    def __init__(self, *, structured: list[Any] | None = None,
                 text: list[str] | None = None) -> None:
        self.structured_queue = list(structured or [])
        self.text_queue = list(text or [])
        self.calls: list[dict[str, Any]] = []

    async def structured_output(self, messages, schema, **kw: Any):
        self.calls.append({"kind": "structured", "messages": messages, **kw})
        if not self.structured_queue:
            raise AssertionError("ScriptedLLM: no structured response queued")
        return self.structured_queue.pop(0)

    async def text_completion(self, messages, **kw: Any) -> str:
        self.calls.append({"kind": "text", "messages": messages, **kw})
        return self.text_queue.pop(0) if self.text_queue else ""

    async def stream_completion(self, messages, **kw: Any):
        self.calls.append({"kind": "stream", "messages": messages, **kw})
        for chunk in self.text_queue:
            yield chunk


@pytest.fixture
def fake_turn_store() -> FakeTurnStore:
    return FakeTurnStore()


@pytest.fixture
def fake_idempotency_store() -> FakeIdempotencyStore:
    return FakeIdempotencyStore()


@pytest.fixture
def scripted_llm() -> ScriptedLLM:
    return ScriptedLLM()


# ── the seam composition.py documents ─────────────────────────────────


def build_deps(**overrides: Any):
    """A real `AppDeps` with fakes in every slot.

    The frozen 13-field dataclass is why no test ever built one. Every field
    is filled with something inert, so a test overrides only what it cares
    about — and, unlike a duck-typed double, a field ADDED to `AppDeps` breaks
    here loudly instead of silently reaching a `getattr(deps, …, None)`.
    """
    from shruti_chat.application.rate_limiter import RateLimiter
    from shruti_chat.application.turn_runner import TurnRunner
    from shruti_chat.composition import AppDeps
    from shruti_chat.config import Settings
    from shruti_chat.infra.cache.memory_kv_cache import MemoryKVCache

    turn_store = overrides.pop("turn_store", None) or FakeTurnStore()
    settings = overrides.pop("settings", None) or Settings(
        _env_file=None, database_url="postgres://test",
        s3_bucket="x", s3_region="us-east-1",
    )
    defaults: dict[str, Any] = {
        "settings": settings,
        "pool": None,
        "embedder": None,
        "chunk_repo": None,
        "catalog_repo": None,
        "rate_limiter": RateLimiter(store=_AllowingRateLimitStore(), settings=settings),
        "jwt_verifier": None,
        "kv_cache": MemoryKVCache(max_entries=16),
        "idempotency_store": FakeIdempotencyStore(),
        "turn_store": turn_store,
        "turn_runner": TurnRunner(turn_store),
        "llm": ScriptedLLM(),
        "chat_graph": None,
    }
    defaults.update(overrides)
    return AppDeps(**defaults)


class _AllowingRateLimitStore:
    """Rate-limit store that counts honestly and never fails.

    Signature matched to `domain/ports/rate_limit_store.RateLimitStore` — the
    first draft guessed it and the seam test caught the mismatch immediately,
    which is the argument for building fakes against the real port instead of
    against what the calling code appears to want.
    """

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    async def increment(self, *, scoped_key: str, key_type: str, limit: int, day):
        from shruti_chat.domain.ports.rate_limit_store import CounterRecord

        self.counts[scoped_key] = self.counts.get(scoped_key, 0) + 1
        return CounterRecord(
            key_type=key_type, count=self.counts[scoped_key], limit=limit,
        )

    async def decrement(self, *, scoped_key: str, day) -> int:
        self.counts[scoped_key] = max(0, self.counts.get(scoped_key, 0) - 1)
        return self.counts[scoped_key]

    async def healthy(self) -> bool:
        return True


@pytest.fixture
def deps():
    """`AppDeps` built from fakes — see `build_deps`."""
    return build_deps()
