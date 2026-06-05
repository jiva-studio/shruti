"""Architectural guard: the domain layer depends only inward.

`domain/` (entities, ports, value objects) is the innermost layer. It
must NOT import the outer layers — application, agent, infra, api,
indexer, observability, research. The only allowed `shruti_chat.*`
imports from inside `domain/` are other `domain` modules.

This used to be violated: `domain/turn_context.py` imported
`agent.marker_expander` / `agent.turn_aliases`, creating a domain↔agent
import cycle. TurnContext was moved to `agent/graph/` to break it. This
test keeps the rule from regressing — it's the cheap, no-extra-tooling
substitute for an import-linter contract (there is no Python lint lane
in CI yet; wire this rule there too if one is added).
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src" / "shruti_chat"
_DOMAIN = _SRC / "domain"

# Outer layers domain must never reach into.
_FORBIDDEN_PREFIXES = (
    "shruti_chat.application",
    "shruti_chat.agent",
    "shruti_chat.infra",
    "shruti_chat.api",
    "shruti_chat.indexer",
    "shruti_chat.observability",
    "shruti_chat.research",
    "shruti_chat.composition",
)


def _imported_modules(path: Path) -> set[str]:
    """All fully-qualified module names imported by a Python file."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            # Only absolute `from shruti_chat... import x` matters here;
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
