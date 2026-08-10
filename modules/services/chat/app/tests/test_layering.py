"""Architectural guard: layers depend inward, and the package graph must not tangle.

Two kinds of rule live here.

*Directional rules* say which modules a directory may import. `domain/` (entities,
ports, value objects) is the innermost layer and reaches nothing; `application/`
orchestrates ports and must not touch adapters, the web framework or a driver;
`research/` mirrors `application/`; `infra/` holds driven adapters, which are
imported by the layers above and import only `domain/`. On top of those sit a few
narrower rules: no cross-package private (`_`-prefixed) imports, `langgraph` only
inside `agent/graph/`, `litellm` only behind the module that wraps it, and no
relative imports (there are none today, and the AST walk below would not resolve
them, so the hole is nailed shut rather than left open).

*Shape rules* look at the whole import graph. Tarjan puts 9 of the 14 top-level
packages into one strongly connected component. That number is recorded as a
ratchet: it may shrink, never grow.

Every directional rule carries an allowlist of the leaks that exist today, and
`test_no_stale_allowlist` fails the moment an entry stops being needed — an
allowlist that only grows is a rule that has been switched off. Adding to one
should take an argument; deleting from one should not.

This is the cheap, no-extra-tooling substitute for an import-linter contract
(there is no Python lint lane in CI yet; wire these rules there too if one is added).
"""

from __future__ import annotations

import ast
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src" / "shruti_chat"
_PKG = "shruti_chat"

_ALL_FILES = tuple(sorted(_SRC.rglob("*.py")))


def _rel(py_file: Path) -> str:
    return str(py_file.relative_to(_SRC))


def _files_under(*subdirs: str) -> tuple[Path, ...]:
    return tuple(f for f in _ALL_FILES if _rel(f).startswith(tuple(s + "/" for s in subdirs)))


@cache
def _tree(py_file: Path) -> ast.Module:
    return ast.parse(py_file.read_text(encoding="utf-8"), filename=str(py_file))


@cache
def _imported_modules(py_file: Path) -> frozenset[str]:
    """Fully-qualified module names imported by a file (module granularity)."""
    names: set[str] = set()
    for node in ast.walk(_tree(py_file)):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        # `node.level != 0` is a relative import, which this walk cannot resolve
        # to a package. `test_no_relative_imports` keeps that count at zero.
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module)
    return frozenset(names)


def _is_package_module(dotted: str) -> bool:
    """True if `shruti_chat.a.b` names a module or package on disk."""
    parts = dotted.split(".")
    if parts[0] != _PKG or len(parts) < 2:
        return False
    base = _SRC.joinpath(*parts[1:])
    return base.with_suffix(".py").is_file() or (base / "__init__.py").is_file()


@cache
def _imported_packages(py_file: Path) -> frozenset[str]:
    """`_imported_modules` plus `from pkg import submodule` resolved to `pkg.submodule`.

    `from shruti_chat import infra` records only `shruti_chat` at module
    granularity, so a rule keyed on the `shruti_chat.infra` prefix never sees
    it and the whole directional table is bypassed by an import style. Aliases
    that name a real module on disk are promoted to their full dotted path;
    anything else (a class, a function, a constant) is left alone, so allowlist
    entries still read as module names.
    """
    names: set[str] = set(_imported_modules(py_file))
    for node in ast.walk(_tree(py_file)):
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.update(
                candidate
                for alias in node.names
                if _is_package_module(candidate := f"{node.module}.{alias.name}")
            )
    return frozenset(names)


@cache
def _imported_targets(py_file: Path) -> frozenset[str]:
    """Import targets at *name* granularity: `from a.b import c` yields `a.b.c` too.

    Needed by the private-import rule — `from agent.tools import _envelope` hides
    the private part in the alias, not in the module path.
    """
    targets: set[str] = set(_imported_modules(py_file))
    for node in ast.walk(_tree(py_file)):
        if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            targets.update(f"{node.module}.{alias.name}" for alias in node.names)
    return frozenset(targets)


def _top_package(module: str) -> str | None:
    """`shruti_chat.agent.tools._fts` -> `agent`; anything outside the package -> None."""
    parts = module.split(".")
    if parts[0] != _PKG or len(parts) < 2:
        return None
    return parts[1]


def _owning_package(py_file: Path) -> str:
    """Top-level package a source file belongs to (`composition.py` -> `composition`)."""
    parts = Path(_rel(py_file)).parts
    return parts[0] if len(parts) > 1 else Path(_rel(py_file)).stem


# ── the rule table ────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Rule:
    """A directional rule plus the leaks it currently tolerates.

    `detect` returns the offending import targets in a file, *before* the
    allowlist is subtracted; `test_no_stale_allowlist` re-runs it to spot
    entries that have been fixed.
    """

    name: str
    files: tuple[Path, ...]
    detect: Callable[[Path], set[str]]
    allowed: dict[str, set[str]]
    reason: str


def _forbids(prefixes: tuple[str, ...]) -> Callable[[Path], set[str]]:
    def detect(py_file: Path) -> set[str]:
        return {mod for mod in _imported_packages(py_file) if mod.startswith(prefixes)}

    return detect


# ── domain/ ───────────────────────────────────────────────────────────
#
# This used to be violated: `domain/turn_context.py` imported
# `agent.marker_expander` / `agent.turn_aliases`, creating a domain↔agent import
# cycle. TurnContext was moved to `agent/graph/` to break it.

_DOMAIN_FORBIDDEN = (
    f"{_PKG}.application",
    f"{_PKG}.agent",
    f"{_PKG}.infra",
    f"{_PKG}.api",
    f"{_PKG}.indexer",
    f"{_PKG}.observability",
    f"{_PKG}.research",
    f"{_PKG}.composition",
)

# ── application/ ──────────────────────────────────────────────────────
#
# The use-case layer orchestrates ports; it must not reach for a concrete
# adapter, the web framework, a driver, or the composition root.
#
# `agent/` is NOT forbidden: the graph is the agent runtime this layer drives,
# and untangling that is a design change, not a lint rule. The
# application↔agent cycle is held instead by the SCC ratchet below.

_APP_FORBIDDEN = (
    f"{_PKG}.infra",
    f"{_PKG}.api",
    f"{_PKG}.indexer",
    f"{_PKG}.composition",
    f"{_PKG}.research",
    "fastapi",
    "asyncpg",
    "redis",
    "sqlite3",
    "httpx",
    "langgraph",
    "litellm",
    "pydantic_settings",
)

_APP_ALLOWED: dict[str, set[str]] = {
    # `AppDeps` is a plain DTO but lives in `composition`, which imports
    # fastapi + asyncpg — so the use case inherits both. Moving it to
    # `application/deps.py` is its own change (it touches every api module).
    "application/chat_turn.py": {f"{_PKG}.composition"},
    # The synthesizer use case types its input on the research pipeline's
    # models. Those DTOs belong in `domain/`, which would cut the edge.
    "application/synthesizer_turn.py": {f"{_PKG}.research.models"},
}

# ── research/ ─────────────────────────────────────────────────────────
#
# Same shape as application/: research is a use-case pipeline over ports, so it
# has no business opening a database or instantiating an adapter itself.

_RESEARCH_FORBIDDEN = (
    f"{_PKG}.infra",
    f"{_PKG}.indexer",
    "sqlite3",
    "asyncpg",
)

_RESEARCH_ALLOWED: dict[str, set[str]] = {
    # Picks an embedding model by hand instead of receiving an embedder port.
    "research/attribution_lookup.py": {f"{_PKG}.infra.repositories.embedding_router"},
    # Both read the library index directly; it should arrive as a port.
    "research/locate.py": {f"{_PKG}.indexer.library.repo"},
    "research/pipeline.py": {f"{_PKG}.indexer.library.repo"},
}

# ── infra/ ────────────────────────────────────────────────────────────
#
# Driven adapters. Everything above imports them; they import `domain/` (the
# ports they implement) and nothing higher. Reaching back up into
# `application/` or `agent/` is what makes the graph a knot rather than a stack.

_INFRA_FORBIDDEN = (
    f"{_PKG}.application",
    f"{_PKG}.agent",
)

_INFRA_ALLOWED: dict[str, set[str]] = {
    # `cache_helpers` is infrastructure wearing a use-case coat — the natural
    # home is `infra/cache/`, which would delete three of these at once.
    "infra/cache/cached_embedder.py": {f"{_PKG}.application.cache_helpers"},
    "infra/repositories/pg_chunk_repository.py": {f"{_PKG}.application.cache_helpers"},
    "infra/translation/llm_translator.py": {f"{_PKG}.application.cache_helpers"},
    # Consumer resolves authors through a use case rather than a port.
    "infra/broker/track_events_consumer.py": {f"{_PKG}.application.author_lookup"},
    # SQLite catalog borrows the agent's FTS query builder.
    "infra/repositories/sqlite_catalog_repository.py": {f"{_PKG}.agent.tools._fts"},
}


# ── cross-package private imports ─────────────────────────────────────


def _private_cross_package(py_file: Path) -> set[str]:
    """`_`-prefixed targets reached from outside their own top-level package.

    A leading underscore is the author saying "mine". Crossing a package
    boundary to take it couples to an implementation detail that carries no
    compatibility promise — and every one of these edges also feeds a cycle.
    """
    owner = _owning_package(py_file)
    offending: set[str] = set()
    for target in _imported_targets(py_file):
        pkg = _top_package(target)
        if pkg is None or pkg == owner:
            continue
        parts = target.split(".")
        for i, part in enumerate(parts):
            if part.startswith("_") and not part.startswith("__"):
                # Report the shortest private prefix so `_envelope` and
                # `_envelope._AUTHORED_KINDS` collapse to one entry.
                offending.add(".".join(parts[: i + 1]))
                break
    return offending


_PRIVATE_ALLOWED: dict[str, set[str]] = {
    "agent/graph/nodes/find_tracks_worker.py": {
        f"{_PKG}.research.pipeline._fallback_corpus_langs"
    },
    "agent/graph/nodes/synthesis_planner.py": {
        f"{_PKG}.research.outline_builder._MIN_THESES_FOR_INTRO"
    },
    "api/chat.py": {f"{_PKG}.application.rate_limiter._next_midnight_utc"},
    "application/react_loop.py": {f"{_PKG}.agent.tools._registry"},
    "infra/broker/track_published_consumer.py": {f"{_PKG}.indexer.run._graft_promoted_track"},
    "infra/repositories/sqlite_catalog_repository.py": {f"{_PKG}.agent.tools._fts"},
    # `_envelope` is the tool-result shape the research pipeline emits; it is a
    # shared contract living in a private module. Promoting it to
    # `domain/` (or `agent/tools/envelope.py`) deletes five entries.
    "research/commentary_expansion.py": {f"{_PKG}.agent.tools._envelope"},
    "research/corpus_fanout.py": {
        f"{_PKG}.agent.tools._envelope",
        f"{_PKG}.agent.tools._helpers",
    },
    "research/pipeline.py": {f"{_PKG}.agent.tools._envelope"},
    "research/thesis_augmentation.py": {f"{_PKG}.agent.tools._envelope"},
}


# ── third-party containment ───────────────────────────────────────────


def _langgraph_outside_graph(py_file: Path) -> set[str]:
    """`langgraph` is the graph runtime, not an ambient utility.

    Importing it elsewhere (typically for `get_stream_writer`) makes the
    orchestration framework leak into code that should be plain Python.
    """
    if _rel(py_file).startswith("agent/graph/"):
        return set()
    return {mod for mod in _imported_modules(py_file) if mod.split(".")[0] == "langgraph"}


_LANGGRAPH_ALLOWED: dict[str, set[str]] = {
    # Streams card payloads out of a node it is called from. Passing the writer
    # in as an argument removes the import.
    "agent/cards.py": {"langgraph.config"},
}

def _litellm_imports(py_file: Path) -> set[str]:
    """Every file that names the vendor SDK, homes included.

    The home is expressed as an allowlist entry rather than an exemption baked
    into `detect`, so `test_no_stale_allowlist` polices it: a home that stops
    importing litellm — or one written down before it ever did — is a stale
    entry and fails. An exemption inside `detect` is invisible to that check,
    which is how `infra/llm_provider/` came to be waved through while importing
    zero litellm.
    """
    return {mod for mod in _imported_modules(py_file) if mod.split(".")[0] == "litellm"}


_LITELLM_ALLOWED: dict[str, set[str]] = {
    # The single wrapper around `litellm.acompletion`.
    "agent/llm.py": {"litellm"},
}


def _acompletion_calls(py_file: Path) -> set[str]:
    """Uses of `agent.llm.acompletion` — the raw model call, one layer below a use case.

    `api/` is a transport layer: it should hand work to `application/`, not
    compose prompts and call a model itself.
    """
    if not any(
        mod == f"{_PKG}.agent.llm" or mod == f"{_PKG}.agent"
        for mod in _imported_modules(py_file)
    ):
        return set()
    calls = {
        f"{_PKG}.agent.llm.acompletion"
        for node in ast.walk(_tree(py_file))
        if isinstance(node, ast.Attribute) and node.attr == "acompletion"
    }
    calls |= {
        target
        for target in _imported_targets(py_file)
        if target == f"{_PKG}.agent.llm.acompletion"
    }
    return calls


_ACOMPLETION_ALLOWED: dict[str, set[str]] = {
    # Conversation-title generation is a whole use case living in a route
    # handler. It belongs in `application/`, behind an LLM port.
    "api/title.py": {f"{_PKG}.agent.llm.acompletion"},
}


_RULES: tuple[_Rule, ...] = (
    _Rule(
        name="domain-depends-only-inward",
        files=_files_under("domain"),
        detect=_forbids(_DOMAIN_FORBIDDEN),
        allowed={},
        reason="domain/ must depend only inward (on other domain modules).",
    ),
    _Rule(
        name="application-does-not-reach-outward",
        files=_files_under("application"),
        detect=_forbids(_APP_FORBIDDEN),
        allowed=_APP_ALLOWED,
        reason=(
            "application/ orchestrates ports; it must not reach for a concrete "
            "adapter, the web framework, a driver, or the composition root."
        ),
    ),
    _Rule(
        name="research-does-not-reach-outward",
        files=_files_under("research"),
        detect=_forbids(_RESEARCH_FORBIDDEN),
        allowed=_RESEARCH_ALLOWED,
        reason=(
            "research/ is a use-case pipeline over ports; it must not open a "
            "database or instantiate an adapter itself."
        ),
    ),
    _Rule(
        name="infra-adapters-are-driven",
        files=_files_under("infra"),
        detect=_forbids(_INFRA_FORBIDDEN),
        allowed=_INFRA_ALLOWED,
        reason=(
            "infra/ holds driven adapters: they implement domain ports and are "
            "imported by the layers above, never the other way round."
        ),
    ),
    _Rule(
        name="no-cross-package-private-imports",
        files=_ALL_FILES,
        detect=_private_cross_package,
        allowed=_PRIVATE_ALLOWED,
        reason=(
            "a leading underscore is package-private; importing it across a "
            "top-level package couples to an implementation detail."
        ),
    ),
    _Rule(
        name="langgraph-confined-to-agent-graph",
        files=_ALL_FILES,
        detect=_langgraph_outside_graph,
        allowed=_LANGGRAPH_ALLOWED,
        reason="langgraph is the graph runtime; only agent/graph/ may import it.",
    ),
    _Rule(
        name="litellm-confined-to-its-wrappers",
        files=_ALL_FILES,
        detect=_litellm_imports,
        allowed=_LITELLM_ALLOWED,
        reason=(
            "only agent/llm.py may name the vendor SDK; everything else goes "
            "through that wrapper."
        ),
    ),
    _Rule(
        name="api-does-not-call-the-model-directly",
        files=_files_under("api"),
        detect=_acompletion_calls,
        allowed=_ACOMPLETION_ALLOWED,
        reason=(
            "api/ is transport: it hands work to application/, it does not "
            "compose prompts and call a model itself."
        ),
    ),
)

_RULE_CASES = tuple((rule, py_file) for rule in _RULES for py_file in rule.files)


def _case_id(case: tuple[_Rule, Path]) -> str:
    rule, py_file = case
    return f"{rule.name}::{_rel(py_file)}"


@pytest.mark.parametrize("case", _RULE_CASES, ids=_case_id)
def test_layer_rule(case: tuple[_Rule, Path]) -> None:
    rule, py_file = case
    rel = _rel(py_file)
    offending = sorted(rule.detect(py_file) - rule.allowed.get(rel, set()))
    assert not offending, f"[{rule.name}] {rel} imports {offending}. {rule.reason}"


@pytest.mark.parametrize("rule", _RULES, ids=lambda r: r.name)
def test_no_stale_allowlist(rule: _Rule) -> None:
    """An allowlist that only ever grows is a rule that has been switched off.

    Once a leak is fixed its entry must go, or the next one slips in under it.
    """
    stale: dict[str, list[str]] = {}
    for rel, allowed in rule.allowed.items():
        unused = allowed - rule.detect(_SRC / rel)
        if unused:
            stale[rel] = sorted(unused)
    assert not stale, (
        f"[{rule.name}] allowlist entries no longer needed — delete them: {stale}"
    )


def test_package_imports_are_visible_to_directional_rules(tmp_path: Path) -> None:
    """`from shruti_chat import infra` must count as importing `infra`.

    At module granularity that statement records only `shruti_chat`, so every
    prefix-keyed rule above would wave it through. There are no live hits today;
    this pins the hole shut before one appears.
    """
    bare = tmp_path / "bare.py"
    bare.write_text("from shruti_chat import infra\n", encoding="utf-8")
    assert _forbids(_APP_FORBIDDEN)(bare) == {f"{_PKG}.infra"}

    nested = tmp_path / "nested.py"
    nested.write_text("from shruti_chat.infra import repositories\n", encoding="utf-8")
    assert _forbids(_APP_FORBIDDEN)(nested) == {
        f"{_PKG}.infra",
        f"{_PKG}.infra.repositories",
    }


def test_non_module_aliases_are_not_promoted(tmp_path: Path) -> None:
    """Only aliases that name a module on disk get their dotted path recorded.

    Promoting every `from x import y` to `x.y` would turn class and function
    names into fake modules, and each allowlist entry would have to spell out
    the symbol rather than the module it came from.
    """
    probe = tmp_path / "probe.py"
    probe.write_text(
        "from shruti_chat.application.cache_helpers import TTL_30D\n", encoding="utf-8"
    )
    assert _imported_packages(probe) == {f"{_PKG}.application.cache_helpers"}


def test_no_relative_imports() -> None:
    """Relative imports would slip past every rule above.

    The walk resolves `from shruti_chat.x import y`, not `from .x import y`,
    so a relative import is invisible to it. There are zero today; keeping it
    that way is cheaper than writing a resolver.
    """
    offending = [
        f"{_rel(py_file)}:{node.lineno}"
        for py_file in _ALL_FILES
        for node in ast.walk(_tree(py_file))
        if isinstance(node, ast.ImportFrom) and node.level != 0
    ]
    assert not offending, (
        f"relative imports are invisible to the layering rules: {offending}. "
        "Use absolute `shruti_chat.…` imports."
    )


# ── package graph shape ───────────────────────────────────────────────


def _package_graph() -> dict[str, set[str]]:
    """Top-level package -> the other top-level packages it imports."""
    graph: dict[str, set[str]] = {}
    for py_file in _ALL_FILES:
        owner = _owning_package(py_file)
        edges = graph.setdefault(owner, set())
        for mod in _imported_modules(py_file):
            target = _top_package(mod)
            if target is not None and target != owner:
                edges.add(target)
                graph.setdefault(target, set())
    return graph


def _strongly_connected(graph: dict[str, set[str]]) -> list[frozenset[str]]:
    """Tarjan, iterative — components of size > 1 are import cycles."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    components: list[frozenset[str]] = []
    counter = 0

    for root in sorted(graph):
        if root in index:
            continue
        work: list[tuple[str, Iterable[str]]] = [(root, iter(sorted(graph[root])))]
        index[root] = low[root] = counter
        counter += 1
        stack.append(root)
        on_stack.add(root)
        while work:
            node, children = work[-1]
            for child in children:
                if child not in index:
                    index[child] = low[child] = counter
                    counter += 1
                    stack.append(child)
                    on_stack.add(child)
                    work.append((child, iter(sorted(graph[child]))))
                    break
                if child in on_stack:
                    low[node] = min(low[node], index[child])
            else:
                work.pop()
                if work:
                    low[work[-1][0]] = min(low[work[-1][0]], low[node])
                if low[node] == index[node]:
                    component: set[str] = set()
                    while True:
                        top = stack.pop()
                        on_stack.discard(top)
                        component.add(top)
                        if top == node:
                            break
                    components.append(frozenset(component))
    return components


def _tangled_packages() -> set[str]:
    return {
        pkg
        for component in _strongly_connected(_package_graph())
        if len(component) > 1
        for pkg in component
    }


# RATCHET — this set may only shrink, never grow. 9 of the 14 top-level packages
# import each other in a single strongly connected component, so the service has
# no layer order at the package level at all: `agent ↔ application`,
# `agent ↔ observability`, `agent ↔ research`, `application ↔ composition`,
# `application ↔ research`, `db ↔ observability`, `indexer ↔ infra`.
# The goal is the empty set. Every entry deleted from an allowlist above chips
# at this; when a package drops out, `test_recorded_cycle_is_not_stale` will say so.
_KNOWN_CYCLE: frozenset[str] = frozenset(
    {
        "agent",
        "application",
        "composition",
        "db",
        "indexer",
        "infra",
        "lecture_search",
        "observability",
        "research",
    }
)


def test_package_cycle_does_not_grow() -> None:
    newly_tangled = sorted(_tangled_packages() - _KNOWN_CYCLE)
    assert not newly_tangled, (
        f"these top-level packages just joined an import cycle: {newly_tangled}. "
        "The package graph must be a DAG; do not widen the knot."
    )


def test_recorded_cycle_is_not_stale() -> None:
    """The ratchet's counterpart: record progress instead of letting it rot.

    Same contract as `test_no_stale_allowlist` — when a package leaves the
    cycle, drop it from `_KNOWN_CYCLE` so it cannot quietly slide back in.
    """
    escaped = sorted(_KNOWN_CYCLE - _tangled_packages())
    assert not escaped, (
        f"these packages are no longer in an import cycle: {escaped}. "
        "Remove them from _KNOWN_CYCLE — the ratchet only counts if it tightens."
    )
