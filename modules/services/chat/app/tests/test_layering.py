"""Architectural guard: the domain layer depends only inward.

`domain/` (entities, ports, value objects) is the innermost layer. It
must NOT import the outer layers — application, agent, infra, api,
indexer, observability, research. The only allowed `lectorium_chat.*`
imports from inside `domain/` are other `domain` modules.

This used to be violated: `domain/turn_context.py` imported
`agent.marker_expander` / `agent.turn_aliases`, creating a domain↔agent
import cycle. TurnContext was moved to `agent/graph/` to break it. This
test keeps the rule from regressing — it's the cheap, no-extra-tooling
substitute for an import-linter contract. There IS a ruff lane in CI now
(`services-chat-tests.yml`), but ruff has no layering rule, so the guard
stays here.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src" / "lectorium_chat"
_DOMAIN = _SRC / "domain"

# Outer layers domain must never reach into.
_FORBIDDEN_PREFIXES = (
    "lectorium_chat.application",
    "lectorium_chat.agent",
    "lectorium_chat.infra",
    "lectorium_chat.api",
    "lectorium_chat.indexer",
    "lectorium_chat.observability",
    "lectorium_chat.research",
    "lectorium_chat.composition",
)


def _imported_modules(path: Path) -> set[str]:
    """All fully-qualified module names imported by a Python file."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            # Only absolute `from lectorium_chat... import x` matters here;
            # relative imports inside domain stay within domain by shape.
            if node.module and node.level == 0:
                names.add(node.module)
    return names


@pytest.mark.parametrize(
    "py_file",
    sorted(_DOMAIN.rglob("*.py")),
    ids=lambda p: str(p.relative_to(_SRC)),
)
def test_domain_imports_only_inward(py_file: Path) -> None:
    offending = sorted(
        mod
        for mod in _imported_modules(py_file)
        if mod.startswith(_FORBIDDEN_PREFIXES)
    )
    assert not offending, (
        f"{py_file.relative_to(_SRC)} imports outer layer(s): {offending}. "
        "domain/ must depend only inward (on other domain modules)."
    )


# ── application/ ──────────────────────────────────────────────────────
#
# The use-case layer orchestrates ports; it must not reach for a concrete
# adapter, the web framework, a driver, or the composition root. Nothing
# enforced this, and it drifted.
#
# `agent/` is NOT forbidden: the graph is the agent runtime this layer drives,
# and untangling that is a design change, not a lint rule.

_APPLICATION = _SRC / "application"

_APP_FORBIDDEN_PREFIXES = (
    "lectorium_chat.infra",
    "lectorium_chat.api",
    "lectorium_chat.indexer",
    "lectorium_chat.composition",
    "fastapi",
    "asyncpg",
    "redis",
    "sqlite3",
    "httpx",
    "langgraph",
    "litellm",
    "pydantic_settings",
)

# Known violations, each with the plan item that removes it. This is an
# ALLOWLIST THAT MUST SHRINK: `test_no_stale_application_allowlist` fails once
# an entry stops being needed, so a fixed leak can't quietly leave the rule
# weakened behind it. Adding to it should take an argument.
_APP_ALLOWED: dict[str, set[str]] = {
    # `AppDeps` is a plain DTO but lives in `composition`, which imports
    # fastapi + asyncpg — so the use case inherits both. Moving it to
    # `application/deps.py` is its own change (it touches every api module).
    "application/chat_turn.py": {"lectorium_chat.composition"},
}


def _violations(py_file: Path, forbidden: tuple[str, ...]) -> set[str]:
    return {
        mod for mod in _imported_modules(py_file) if mod.startswith(forbidden)
    }


@pytest.mark.parametrize(
    "py_file",
    sorted(_APPLICATION.rglob("*.py")),
    ids=lambda p: str(p.relative_to(_SRC)),
)
def test_application_does_not_reach_outward(py_file: Path) -> None:
    rel = str(py_file.relative_to(_SRC))
    offending = _violations(py_file, _APP_FORBIDDEN_PREFIXES) - _APP_ALLOWED.get(rel, set())
    assert not offending, (
        f"{rel} imports {sorted(offending)}. application/ orchestrates ports; "
        "it must not reach for a concrete adapter, the web framework, a "
        "driver, or the composition root."
    )


def test_no_stale_application_allowlist() -> None:
    """An allowlist that only ever grows is a rule that has been switched off.
    Once a leak is fixed its entry must go, or the next one slips in under it."""
    stale: dict[str, set[str]] = {}
    for rel, allowed in _APP_ALLOWED.items():
        actual = _violations(_SRC / rel, _APP_FORBIDDEN_PREFIXES)
        unused = allowed - actual
        if unused:
            stale[rel] = unused
    assert not stale, f"allowlist entries no longer needed — delete them: {stale}"
