#!/usr/bin/env python3
"""Universal Monorepo Architecture & Layer Guard for Shruti.

Mechanically verifies hexagonal layer boundaries, dependency directions,
and isolation rules across:
  1. Mobile & Web apps + TypeScript libraries (@lib/domain, @lib/ui, @usecases, @infra, @ports)
  2. Python Chat service (domain, application, infra, agent, research, composition)
  3. Go services (internal/domain, internal/ports, internal/application vs infra/store/handler)

Exits with code 1 and screams loudly with exact file/line locations if any rule is broken.
"""

from __future__ import annotations

import ast
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

IGNORED_DIRS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "dist",
    "build",
    "coverage",
    ".direnv",
    ".pytest_cache",
    ".ruff_cache",
    "__pycache__",
    "android",
    "ios",
    "submodules",  # checked via canonical modules/ path to avoid duplicate hits
}


@dataclass(frozen=True)
class Violation:
    file_path: Path
    line_number: int
    layer: str
    target: str
    reason: str

    def format(self, root: Path) -> str:
        try:
            rel = self.file_path.relative_to(root)
        except ValueError:
            rel = self.file_path
        return f"🚨 [ARCH VIOLATION] {rel}:{self.line_number}\n   Layer:  {self.layer}\n   Target: {self.target}\n   Reason: {self.reason}\n"


class ArchitectureScanner:
    def __init__(self, repo_root: Path):
        self.repo_root = repo_root.resolve()
        self.violations: list[Violation] = []

    def _walk_files(self, base_dir: Path, extensions: tuple[str, ...]) -> list[Path]:
        matched: list[Path] = []
        for root, dirs, files in os.walk(base_dir, followlinks=False):
            dirs[:] = [d for d in dirs if d not in IGNORED_DIRS and not d.startswith(".")]
            for f in files:
                if f.endswith(extensions) and not any(f.endswith(s) for s in [".test.ts", ".spec.ts", "_test.go"]):
                    matched.append(Path(root) / f)
        return matched

    def scan_all(self) -> list[Violation]:
        self.violations.clear()
        self._scan_mobile_and_libs()
        self._scan_python_chat()
        self._scan_go_services()
        return self.violations

    # ──────────────────────────────────────────────────────────────────────────
    # 1. TypeScript / Vue Layer Scanner
    # ──────────────────────────────────────────────────────────────────────────

    def _scan_mobile_and_libs(self) -> None:
        modules = self.repo_root / "modules"
        ts_vue_files = self._walk_files(modules, (".ts", ".vue"))
        import_re = re.compile(
            r"""(?:import\s+(?:type\s+)?(?:.*?from\s+)?|export\s+(?:type\s+)?(?:.*?from\s+)?|require\s*\()\s*['"]([^'"]+)['"]"""
        )

        for file_path in ts_vue_files:
            rel_str = str(file_path.relative_to(self.repo_root))
            if "__tests__" in rel_str:
                continue

            try:
                content = file_path.read_text(encoding="utf-8")
            except Exception:
                continue

            for line_idx, line in enumerate(content.splitlines(), start=1):
                for match in import_re.finditer(line):
                    target = match.group(1)
                    self._check_ts_import(file_path, line_idx, rel_str, target)

    def _check_ts_import(self, file_path: Path, line_no: int, rel: str, target: str) -> None:
        # Rules for @lib/domain (modules/libs/domain)
        if "modules/libs/domain/" in rel:
            if any(target.startswith(b) for b in ["@usecases", "@ports", "@infra", "@ui", "@shruti", "vue", "@ionic"]):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Domain (Pure)",
                        target=target,
                        reason="Domain must be pure and never import usecases, ports, infra, ui, or frameworks.",
                    )
                )

        # Rules for @usecases (modules/apps/mobile/usecases)
        elif "modules/apps/mobile/usecases/" in rel or "/usecases/" in rel:
            if any(target.startswith(b) for b in ["@ports", "@infra", "@ui", "@shruti", "@lib/persistence", "vue", "@ionic"]):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="UseCases / Application Layer",
                        target=target,
                        reason="Application usecases must not import technical ports, infrastructure, UI, or frameworks.",
                    )
                )

        # Rules for @ui (modules/apps/mobile/ui)
        elif "modules/apps/mobile/ui/" in rel:
            if any(target.startswith(b) for b in ["@ports", "@infra", "@lib/domain", "@usecases", "@shruti"]):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Mobile UI Layer",
                        target=target,
                        reason="UI must be humble and never import domain entities, usecases, ports, or infra (use mirror types).",
                    )
                )

        # Rules for @lib/ui (modules/libs/ui - Shared UI)
        elif "modules/libs/ui/" in rel:
            if any(target.startswith(b) for b in ["@ports", "@infra", "@lib/domain", "@lib/catalog", "@lib/contracts", "@lib/persistence", "@usecases", "@shruti", "@ionic"]):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Shared UI Library (@lib/ui)",
                        target=target,
                        reason="Shared UI library must be strictly domain-agnostic and cannot import @lib/catalog, domain, contracts, or Ionic.",
                    )
                )

        # Rules for @ports/app (modules/apps/mobile/ports)
        elif "modules/apps/mobile/ports/" in rel:
            if any(target.startswith(b) for b in ["@lib/domain", "@usecases", "@infra", "@ui", "@shruti"]):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Ports (App Interfaces)",
                        target=target,
                        reason="Technical ports must not import domain, usecases, infra, or UI.",
                    )
                )

        # Rules for persistence row types (@lib/persistence)
        elif "modules/libs/persistence/" in rel:
            if any(target.startswith(b) for b in ["@lib/domain", "@usecases", "@infra", "@ports", "@ui", "@shruti"]):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Persistence Schemas",
                        target=target,
                        reason="Persistence row types must be pure schemas with zero imports.",
                    )
                )

    # ──────────────────────────────────────────────────────────────────────────
    # 2. Python Chat Service Layer Scanner
    # ──────────────────────────────────────────────────────────────────────────

    def _scan_python_chat(self) -> None:
        chat_src = self.repo_root / "modules" / "services" / "chat" / "app" / "src" / "shruti_chat"
        if not chat_src.exists():
            return

        py_files = self._walk_files(chat_src, (".py",))
        for file_path in py_files:
            rel = str(file_path.relative_to(chat_src))
            try:
                tree = ast.parse(file_path.read_text(encoding="utf-8"), filename=str(file_path))
            except Exception:
                continue

            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        self._check_python_import(file_path, node.lineno, rel, alias.name)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    self._check_python_import(file_path, node.lineno, rel, node.module)

    def _check_python_import(self, file_path: Path, line_no: int, rel: str, module: str) -> None:
        pkg = "shruti_chat"

        if rel.startswith("domain/"):
            forbidden = (f"{pkg}.application", f"{pkg}.agent", f"{pkg}.infra", f"{pkg}.api", f"{pkg}.research", f"{pkg}.composition")
            if module.startswith(forbidden):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Python Chat: Domain",
                        target=module,
                        reason="domain/ must be innermost and cannot import application, agent, infra, or api.",
                    )
                )

        elif rel.startswith("application/"):
            forbidden = (f"{pkg}.infra", f"{pkg}.api", f"{pkg}.composition", "fastapi", "asyncpg", "redis")
            if module.startswith(forbidden):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Python Chat: Application",
                        target=module,
                        reason="application/ use cases must orchestrate ports and never import adapters, composition, or drivers.",
                    )
                )

        elif rel.startswith("infra/"):
            forbidden = (f"{pkg}.application", f"{pkg}.agent")
            if module.startswith(forbidden):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Python Chat: Infra",
                        target=module,
                        reason="infra/ driven adapters implement ports and must never import application use cases or agent graph.",
                    )
                )

        elif rel.startswith("research/"):
            forbidden = (f"{pkg}.infra", "sqlite3", "asyncpg")
            if module.startswith(forbidden):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Python Chat: Research",
                        target=module,
                        reason="research/ is a domain pipeline and cannot open databases or import adapters directly.",
                    )
                )

    # ──────────────────────────────────────────────────────────────────────────
    # 3. Go Services Layer Scanner
    # ──────────────────────────────────────────────────────────────────────────

    def _scan_go_services(self) -> None:
        services_dir = self.repo_root / "modules" / "services"
        if not services_dir.exists():
            return

        go_files = self._walk_files(services_dir, (".go",))
        single_import_re = re.compile(r'"([^"]+)"')

        for file_path in go_files:
            rel = str(file_path.relative_to(services_dir))
            try:
                content = file_path.read_text(encoding="utf-8")
            except Exception:
                continue

            for line_idx, line in enumerate(content.splitlines(), start=1):
                match = single_import_re.search(line)
                if match:
                    target = match.group(1)
                    self._check_go_import(file_path, line_idx, rel, target)

    def _check_go_import(self, file_path: Path, line_no: int, rel: str, target: str) -> None:
        if "/internal/domain/" in rel:
            if any(x in target for x in ["/internal/infra", "/internal/store", "/internal/handler", "/internal/application", "github.com/jackc/pgx", "github.com/redis"]):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Go Service: Domain",
                        target=target,
                        reason="Go domain package must not import infra, store, handler, application, or DB drivers.",
                    )
                )

        elif "/internal/ports/" in rel:
            if any(x in target for x in ["/internal/infra", "/internal/store", "/internal/handler", "github.com/jackc/pgx"]):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Go Service: Ports",
                        target=target,
                        reason="Go ports package must not import concrete adapters or DB drivers.",
                    )
                )

        elif "/internal/application/" in rel:
            if any(x in target for x in ["/internal/infra", "/internal/handler"]):
                self.violations.append(
                    Violation(
                        file_path=file_path,
                        line_number=line_no,
                        layer="Go Service: Application",
                        target=target,
                        reason="Go application layer must not import infra adapters or HTTP handlers.",
                    )
                )


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    scanner = ArchitectureScanner(repo_root)
    violations = scanner.scan_all()

    if not violations:
        print("✅ Architecture Guard: All layer boundaries and dependency directions are CLEAN.")
        return 0

    print("=" * 80)
    print(f"❌ ARCHITECTURE CHECK FAILED: Found {len(violations)} architectural violations!")
    print("=" * 80)
    for v in violations:
        print(v.format(repo_root))

    print("=" * 80)
    print("Zero-tolerance mode: fix layer leaks to keep architecture pure.")
    print("=" * 80)
    return 1


if __name__ == "__main__":
    sys.exit(main())
