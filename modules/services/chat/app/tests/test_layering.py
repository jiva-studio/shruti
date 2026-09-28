"""Architectural guard: layers depend inward, and the package graph must not tangle.

Two kinds of rule live here.

*Directional rules* say which modules a directory may import. `domain/` (entities,
ports, value objects) is the innermost layer and reaches nothing; `application/`
orchestrates ports and must not touch adapters, the web framework, a driver or
the settings object; `research/` mirrors `application/`; `infra/` holds driven
adapters, which are imported by the layers above and import only `domain/`.
`agent/` is the agent runtime, `api/` the HTTP transport, `indexer/` the batch
job that publishes the corpus, `db/` the Postgres pool and `observability/` the
cross-cutting logging / metrics / tracing layer — each has its own table below.
On top of those sit a few narrower rules: no cross-package private
(`_`-prefixed) imports, `langgraph` only inside `agent/graph/`, `litellm` only
behind the module that wraps it. Relative imports are resolved to their
absolute module before any rule sees them.

*Shape rules* look at the whole import graph. Tarjan finds one strongly
connected component spanning most of the top-level packages; its membership is
recorded in `_KNOWN_CYCLE` as a ratchet: it may shrink, never grow.

Every directional rule carries an allowlist of the leaks that exist today, and
`test_no_stale_allowlist` fails the moment an entry stops being needed — an
allowlist that only grows is a rule that has been switched off. Adding to one
should take an argument; deleting from one should not.

This is the cheap, no-extra-tooling substitute for an import-linter contract.
The ruff lane in CI (`services-chat-tests.yml`) has no layering rule, so the
guard lives here.
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


def _package_of(py_file: Path) -> tuple[str, ...]:
    """Dotted package a source file lives in: `agent/tools/x.py` -> `shruti_chat.agent.tools`.

    `__init__.py` belongs to its own directory's package, exactly like a module
    next to it, so the same rule applies to both. The probe files the tests
    below write live outside the tree and are read as top-level modules of the
    package.
    """
    if not py_file.is_relative_to(_SRC):
        return (_PKG,)
    return (_PKG, *Path(_rel(py_file)).parent.parts)


def _absolute_module(package: tuple[str, ...], level: int, module: str | None) -> str | None:
    """The module a `from ... import` names, relative imports resolved.

    `level` is the number of leading dots: 1 is the file's own package, each
    further dot one package up. None when the dots climb out of the package.
    """
    if level == 0:
        return module
    if level - 1 >= len(package):
        return None
    base = package[: len(package) - (level - 1)]
    return ".".join((*base, *module.split("."))) if module else ".".join(base)


@dataclass(frozen=True)
class _Imports:
    modules: frozenset[str]
    """Fully-qualified modules named by the import statements."""
    packages: frozenset[str]
    """`modules` plus aliases that are themselves modules on disk."""
    targets: frozenset[str]
    """`modules` plus every `module.alias`, module or not."""


def _collect_imports(tree: ast.Module, package: tuple[str, ...]) -> _Imports:
    modules: set[str] = set()
    packages: set[str] = set()
    targets: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = {alias.name for alias in node.names}
            modules |= names
            packages |= names
            targets |= names
        elif isinstance(node, ast.ImportFrom):
            module = _absolute_module(package, node.level, node.module)
            if module is None:
                continue
            modules.add(module)
            packages.add(module)
            targets.add(module)
            for alias in node.names:
                candidate = f"{module}.{alias.name}"
                targets.add(candidate)
                if _is_package_module(candidate):
                    packages.add(candidate)
    return _Imports(frozenset(modules), frozenset(packages), frozenset(targets))


@cache
def _imports(py_file: Path) -> _Imports:
    return _collect_imports(_tree(py_file), _package_of(py_file))


def _imported_modules(py_file: Path) -> frozenset[str]:
    """Fully-qualified module names imported by a file (module granularity)."""
    return _imports(py_file).modules


def _is_package_module(dotted: str) -> bool:
    """True if `shruti_chat.a.b` names a module or package on disk."""
    parts = dotted.split(".")
    if parts[0] != _PKG or len(parts) < 2:
        return False
    base = _SRC.joinpath(*parts[1:])
    return base.with_suffix(".py").is_file() or (base / "__init__.py").is_file()


def _imported_packages(py_file: Path) -> frozenset[str]:
    """`_imported_modules` plus `from pkg import submodule` resolved to `pkg.submodule`.

    `from shruti_chat import infra` records only `shruti_chat` at module
    granularity, so a rule keyed on the `shruti_chat.infra` prefix never sees
    it and the whole directional table is bypassed by an import style. Aliases
    that name a real module on disk are promoted to their full dotted path;
    anything else (a class, a function, a constant) is left alone, so allowlist
    entries still read as module names.
    """
    return _imports(py_file).packages


def _imported_targets(py_file: Path) -> frozenset[str]:
    """Import targets at *name* granularity: `from a.b import c` yields `a.b.c` too.

    Needed by the private-import rule — `from agent.tools import _envelope` hides
    the private part in the alias, not in the module path.
    """
    return _imports(py_file).targets


def _top_package(module: str) -> str | None:
    """`shruti_chat.agent.tools._envelope` -> `agent`; anything outside the package -> None."""
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
# The innermost layer imports nothing else from the package. TurnContext lives
# in `agent/graph/` because it holds agent types (`marker_expander`,
# `turn_aliases`).

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

# Keep it empty — an entry added here is a rule waived.
_RESEARCH_ALLOWED: dict[str, set[str]] = {}

# ── infra/ ────────────────────────────────────────────────────────────
#
# Driven adapters. Everything above imports them; they import `domain/` (the
# ports they implement) and nothing higher. Reaching back up into
# `application/` or `agent/` is what makes the graph a knot rather than a stack.

_INFRA_FORBIDDEN = (
    f"{_PKG}.application",
    f"{_PKG}.agent",
)

_INFRA_ALLOWED: dict[str, set[str]] = {}

# ── application/ must not read settings ───────────────────────────────
#
# A use case takes its knobs as arguments from the composition root. Reading
# the process-wide `Settings` (`shruti_chat.config`, `get_settings()`) from
# inside one ties it to the environment and makes every test patch a global.

_APP_SETTINGS_FORBIDDEN = (f"{_PKG}.config",)

_APP_SETTINGS_ALLOWED: dict[str, set[str]] = {
    # `AppDeps.settings` is typed on `Settings`; the dataclass is the carrier
    # the composition root fills, so the type import is the whole leak.
    "application/deps.py": {f"{_PKG}.config"},
    # Reads `llm_default` via `get_settings()` inside the turn; passing the
    # model name in from the route removes the import.
    "application/proactive_turn.py": {f"{_PKG}.config"},
    # Takes `Settings` in its constructor for the per-tier caps; a small
    # limits value object would replace it.
    "application/rate_limiter.py": {f"{_PKG}.config"},
}

# ── agent/ ────────────────────────────────────────────────────────────
#
# The agent runtime (graph, nodes, tools) works on ports handed to it through
# `AppDeps` / `bind_repositories`. It does not open a connection, build an
# adapter, serve HTTP or reach into the composition root or the indexer.

_AGENT_FORBIDDEN = (
    f"{_PKG}.api",
    f"{_PKG}.composition",
    f"{_PKG}.main",
    f"{_PKG}.indexer",
    f"{_PKG}.infra",
    f"{_PKG}.db",
    "fastapi",
    "asyncpg",
    "sqlite3",
    "redis",
)

_AGENT_ALLOWED: dict[str, set[str]] = {}

# ── api/ ──────────────────────────────────────────────────────────────
#
# HTTP transport. Routes read `AppDeps` and hand work to `application/`; they
# do not open databases or run the indexer themselves.

_API_FORBIDDEN = (
    f"{_PKG}.main",
    f"{_PKG}.db",
    f"{_PKG}.indexer",
    "asyncpg",
    "sqlite3",
    "redis",
    "litellm",
)

_API_ALLOWED: dict[str, set[str]] = {
    # The admin routes run the indexer and build its embedder (`/reindex`) and
    # read the pool (`/status`) directly. An admin use case in `application/`
    # behind ports would cut all three edges.
    "api/admin.py": {
        f"{_PKG}.db.client",
        f"{_PKG}.indexer",
        f"{_PKG}.indexer.run",
        f"{_PKG}.indexer.embed",
    },
}

# ── indexer/ ──────────────────────────────────────────────────────────
#
# The batch job that downloads and publishes the corpus. It sits beside the
# request path, not on top of it: nothing about serving a turn belongs here.

_INDEXER_FORBIDDEN = (
    f"{_PKG}.api",
    f"{_PKG}.agent",
    f"{_PKG}.application",
    f"{_PKG}.research",
    f"{_PKG}.composition",
    f"{_PKG}.main",
    "fastapi",
    "litellm",
    "langgraph",
)

_INDEXER_ALLOWED: dict[str, set[str]] = {}

# ── db/ ───────────────────────────────────────────────────────────────
#
# The Postgres pool and the boot-time schema probe. A leaf: settings,
# logging and domain types only.

_DB_FORBIDDEN = (
    f"{_PKG}.api",
    f"{_PKG}.agent",
    f"{_PKG}.application",
    f"{_PKG}.research",
    f"{_PKG}.indexer",
    f"{_PKG}.infra",
    f"{_PKG}.lecture_search",
    f"{_PKG}.composition",
    f"{_PKG}.main",
)

_DB_ALLOWED: dict[str, set[str]] = {}

# ── observability/ ────────────────────────────────────────────────────
#
# Logging, metrics, tracing and scoring are imported by every layer, so they
# must import none of them back — each such edge is a cycle by construction.

_OBSERVABILITY_FORBIDDEN = (
    f"{_PKG}.api",
    f"{_PKG}.agent",
    f"{_PKG}.application",
    f"{_PKG}.research",
    f"{_PKG}.indexer",
    f"{_PKG}.infra",
    f"{_PKG}.db",
    f"{_PKG}.lecture_search",
    f"{_PKG}.composition",
    f"{_PKG}.main",
)

_OBSERVABILITY_ALLOWED: dict[str, set[str]] = {
    # Both parse the answer's inline markers to score / annotate a trace. The
    # marker grammar is a pure value type; moving `agent/markers.py` (and the
    # alias types it references) into `domain/` removes these entries.
    "observability/auto_scores.py": {f"{_PKG}.agent.markers"},
    "observability/marker_annotations.py": {
        f"{_PKG}.agent.markers",
        f"{_PKG}.agent.turn_aliases",
    },
    # The pool gauges read the live pool at scrape time. Registering a
    # collector from `db/client.py` (which already imports observability)
    # inverts the edge.
    "observability/metrics.py": {f"{_PKG}.db", f"{_PKG}.db.client"},
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
    "application/react_loop.py": {f"{_PKG}.agent.tools._registry"},
    "infra/broker/track_published_consumer.py": {f"{_PKG}.indexer.run._graft_promoted_track"},
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
    entry and fails. An exemption inside `detect` is invisible to that check.
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
        name="application-does-not-read-settings",
        files=_files_under("application"),
        detect=_forbids(_APP_SETTINGS_FORBIDDEN),
        allowed=_APP_SETTINGS_ALLOWED,
        reason=(
            "application/ takes its configuration as arguments from the "
            "composition root; it must not import shruti_chat.config."
        ),
    ),
    _Rule(
        name="agent-runs-on-ports",
        files=_files_under("agent"),
        detect=_forbids(_AGENT_FORBIDDEN),
        allowed=_AGENT_ALLOWED,
        reason=(
            "agent/ works on ports handed in by the composition root; it must "
            "not build adapters, open connections or serve HTTP."
        ),
    ),
    _Rule(
        name="api-is-transport",
        files=_files_under("api"),
        detect=_forbids(_API_FORBIDDEN),
        allowed=_API_ALLOWED,
        reason=(
            "api/ hands work to application/; it must not open a database, "
            "run the indexer or call the model SDK itself."
        ),
    ),
    _Rule(
        name="indexer-stays-off-the-request-path",
        files=_files_under("indexer"),
        detect=_forbids(_INDEXER_FORBIDDEN),
        allowed=_INDEXER_ALLOWED,
        reason=(
            "indexer/ is the corpus batch job; it must not import the request "
            "path (api, agent, application, research, composition)."
        ),
    ),
    _Rule(
        name="db-is-a-leaf",
        files=_files_under("db"),
        detect=_forbids(_DB_FORBIDDEN),
        allowed=_DB_ALLOWED,
        reason="db/ is the pool and schema probe; it imports only config, logging and domain.",
    ),
    _Rule(
        name="observability-imports-no-layer",
        files=_files_under("observability"),
        detect=_forbids(_OBSERVABILITY_FORBIDDEN),
        allowed=_OBSERVABILITY_ALLOWED,
        reason=(
            "observability/ is imported by every layer; importing one back "
            "is an import cycle."
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
        "from shruti_chat.domain.cache import TTL_30D\n", encoding="utf-8"
    )
    assert _imported_packages(probe) == {f"{_PKG}.domain.cache"}


@pytest.mark.parametrize(
    ("package", "level", "module", "expected"),
    [
        ((_PKG, "application"), 0, f"{_PKG}.infra", f"{_PKG}.infra"),
        ((_PKG, "application"), 1, "deps", f"{_PKG}.application.deps"),
        ((_PKG, "application"), 2, "infra.cache", f"{_PKG}.infra.cache"),
        ((_PKG, "agent", "graph", "nodes"), 3, "tools", f"{_PKG}.agent.tools"),
        ((_PKG, "application"), 2, None, _PKG),
        ((_PKG, "application"), 3, "x", None),
    ],
)
def test_relative_imports_resolve_to_absolute_modules(
    package: tuple[str, ...], level: int, module: str | None, expected: str | None
) -> None:
    assert _absolute_module(package, level, module) == expected


def test_relative_imports_are_visible_to_directional_rules(tmp_path: Path) -> None:
    """`from ..infra import x` must trip the same rule as the absolute spelling.

    The probe is read as a module of the top-level package, so one dot is
    `shruti_chat` itself.
    """
    dotted = tmp_path / "dotted.py"
    dotted.write_text("from .infra import repositories\n", encoding="utf-8")
    assert _forbids(_APP_FORBIDDEN)(dotted) == {
        f"{_PKG}.infra",
        f"{_PKG}.infra.repositories",
    }

    bare = tmp_path / "bare_dot.py"
    bare.write_text("from . import config\n", encoding="utf-8")
    assert _forbids(_APP_SETTINGS_FORBIDDEN)(bare) == {f"{_PKG}.config"}


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


# RATCHET — this set may only shrink, never grow. These top-level packages import
# each other in a single strongly connected component, so they have no layer
# order among themselves. Direct two-way edges among them include
# `agent ↔ application`, `agent ↔ observability`, `agent ↔ research`,
# `db ↔ observability` and `indexer ↔ infra`.
# The goal is the empty set. Every entry deleted from an allowlist above chips
# at this; when a package drops out, `test_recorded_cycle_is_not_stale` will say so.
_KNOWN_CYCLE: frozenset[str] = frozenset(
    {
        "agent",
        "application",
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
