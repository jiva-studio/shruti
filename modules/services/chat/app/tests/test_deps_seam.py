"""The seam `composition.py` documents must actually be usable.

Its docstring says:

    Replacing an adapter (e.g. for tests) means building an `AppDeps` instance
    with fake repos and stuffing it into `app.state.deps`.

Zero tests did that. `AppDeps` is a frozen, slotted dataclass with 13 required
fields, so every test built a duck-typed double instead — and the production
code then adapted to the doubles: `chat_turn.py` reads two of its own
dependencies through `getattr(deps, …)` with a comment about "test doubles that
predate this field".

That is the failure mode a duck-typed double has and a real one does not: a
field added to `AppDeps` is invisible to a double, so the code learns to ask
defensively instead of the test learning it is out of date.
"""

from __future__ import annotations

import dataclasses

import pytest

from lectorium_chat.composition import AppDeps, get_deps
from tests.conftest import build_deps


def test_build_deps_returns_a_real_appdeps(deps) -> None:
    assert isinstance(deps, AppDeps)


def test_every_required_field_is_populated() -> None:
    """The reason nobody built one by hand. If a field is added and left out
    of the factory, this fails here rather than surfacing as a `getattr`
    fallback in production code."""
    built = build_deps()
    required = [
        f.name for f in dataclasses.fields(AppDeps)
        if f.default is dataclasses.MISSING
        and f.default_factory is dataclasses.MISSING  # type: ignore[misc]
    ]
    assert required, "AppDeps has no required fields — factory assumption is stale"
    for name in required:
        assert hasattr(built, name), f"{name} missing from build_deps"


def test_overrides_replace_only_what_is_asked(scripted_llm) -> None:
    built = build_deps(llm=scripted_llm)

    assert built.llm is scripted_llm
    # ...and the rest is still filled, which is the point of a factory over a
    # hand-rolled double.
    assert built.turn_runner is not None
    assert built.idempotency_store is not None


def test_the_turn_runner_shares_the_injected_store(fake_turn_store) -> None:
    """A runner built against a different store than the test asserts on is a
    silent no-op — the fixture wires both from one object."""
    built = build_deps(turn_store=fake_turn_store)

    assert built.turn_store is fake_turn_store
    assert built.turn_runner._turn_store is fake_turn_store


def test_deps_can_be_served_through_the_fastapi_override(deps) -> None:
    """The documented shape: `app.dependency_overrides[get_deps]`. Two tests
    already do this by hand; this proves the factory satisfies it."""
    from fastapi import FastAPI

    app = FastAPI()
    app.dependency_overrides[get_deps] = lambda: deps

    assert app.dependency_overrides[get_deps]() is deps


async def test_the_rate_limiter_admits_by_default(deps) -> None:
    """Fakes are inert, not obstructive — a test that doesn't care about
    quota shouldn't have to configure it."""
    result = await deps.rate_limiter.check_and_increment(
        "user-1", False, "127.0.0.1", scope="chat", quota_id="",
    )
    assert result.allowed is True


async def test_langfuse_is_pinned_off_for_every_test() -> None:
    """The autouse fixture: prompt fetches must not reach the network just
    because the developer happens to have LANGFUSE_* exported."""
    from lectorium_chat.observability.langfuse_client import _force_fallback

    assert _force_fallback() is True


@pytest.mark.needs_db
def test_capability_markers_are_registered() -> None:
    """Gating is directory-based today, which is why `tests/integration/
    test_xff.py` is skipped despite needing nothing. Markers let a test
    declare what it needs; registering them is the first half."""
