"""Proves that each authoritative architecture gate refuses a known violation.

Every entry in manifest.json names a fixture — one file breaking one rule — and
the gate that must refuse it. For each entry the fixture (and any `support`
files it needs beside it) is copied to the place in the tree it names (the path
under ts/, py/ or go/ is the repository-relative target), the gate runs, and
the copies are removed again. The entry passes when the gate exits non-zero
and its output names the fixture.

Every entry is `active`. Anything short of a refusal fails the run: an entry
with another status, a gate whose configuration (`requires`) is missing, a
tool that is not installed, or a gate that let the fixture through.

Entries run in parallel (GATE_FIXTURES_JOBS, default 4). A fixture present in
the tree while another gate runs cannot make that gate pass: the output must
name that entry's own fixture.

Standard library only; run with `uv run --no-project python`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
STACK_DIRS = ("ts/", "py/", "go/")


@dataclass
class Outcome:
    entry_id: str
    status: str  # PASS | FAIL
    detail: str


def target_of(fixture: str) -> Path:
    for prefix in STACK_DIRS:
        if fixture.startswith(prefix):
            return REPO_ROOT / fixture[len(prefix) :]
    raise ValueError(f"fixture path must start with one of {STACK_DIRS}: {fixture}")


def marker_of(fixture: str) -> str:
    """The path component the gate's output must name."""
    return next(part for part in Path(fixture).parts if "gatefixture" in part)


def golangci_lint() -> str:
    override = os.environ.get("GOLANGCI_LINT")
    if override:
        return override
    found = shutil.which("golangci-lint")
    if found:
        return found
    try:
        gopath = subprocess.run(["go", "env", "GOPATH"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "golangci-lint"
    return str(Path(gopath) / "bin" / "golangci-lint")


def go_module_dir(target: Path) -> Path:
    for parent in target.parents:
        if (parent / "go.mod").is_file():
            return parent
    raise ValueError(f"no go.mod above {target}")


def build_command(entry: dict, gate: dict, target: Path) -> tuple[list[str], Path]:
    values: dict[str, str] = {"golangci_lint": golangci_lint()}
    if target.suffix == ".go":
        module = go_module_dir(target)
        values["module_dir"] = str(module)
        values["package_rel"] = str(target.parent.relative_to(module))
    workdir = REPO_ROOT / gate["workdir"].format(**values)
    values["path"] = entry.get("path") or os.path.relpath(target, workdir)
    return [part.format(**values) for part in gate["command"]], workdir


def missing_tool(cmd: list[str], workdir: Path) -> str | None:
    exe = cmd[0]
    if shutil.which(exe, path=os.environ.get("PATH")) is None and not (workdir / exe).is_file():
        return f"{exe} not installed"
    if exe == "npx" and not (workdir / "node_modules").is_dir():
        return f"node_modules not installed in {workdir.relative_to(REPO_ROOT)} (npm ci)"
    return None


class Placement:
    """Copies fixtures into the tree and takes them out again.

    Parallel entries may create the same missing directory; each directory is
    counted and removed when the last file placed under it is gone.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._dirs: dict[Path, int] = {}
        self._created: set[Path] = set()

    def place(self, pairs: list[tuple[Path, Path]]) -> list[Path]:
        with self._lock:
            for _, target in pairs:
                if target.exists():
                    raise FileExistsError(f"refusing to overwrite {target}")
            for src, target in pairs:
                for directory in reversed(target.parents):
                    if not directory.exists():
                        directory.mkdir()
                        self._created.add(directory)
                    if directory in self._created:
                        self._dirs[directory] = self._dirs.get(directory, 0) + 1
                shutil.copyfile(src, target)
            return [target for _, target in pairs]

    def remove(self, targets: list[Path]) -> None:
        with self._lock:
            for target in targets:
                target.unlink(missing_ok=True)
                for directory in target.parents:
                    if directory not in self._created:
                        continue
                    self._dirs[directory] -= 1
                    if self._dirs[directory] == 0:
                        directory.rmdir()
                        self._created.discard(directory)
                        del self._dirs[directory]


PLACEMENT = Placement()


def run_entry(entry: dict, gates: dict) -> Outcome:
    entry_id = entry["id"]
    gate_name = entry["gate"]
    if entry.get("status") != "active":
        return Outcome(entry_id, "FAIL", f"status is {entry.get('status')!r}; every entry must be active")
    gate = gates.get(gate_name)
    if gate is None:
        return Outcome(entry_id, "FAIL", f"no gate named {gate_name!r} in the manifest")
    absent = [req for req in gate.get("requires", []) if not (REPO_ROOT / req).is_file()]
    if absent:
        return Outcome(entry_id, "FAIL", f"{gate_name}: configuration missing: {', '.join(absent)}")

    target = target_of(entry["fixture"])
    cmd, workdir = build_command(entry, gate, target)
    missing = missing_tool(cmd, workdir)
    if missing:
        return Outcome(entry_id, "FAIL", f"{gate_name}: {missing}")

    sources = [entry["fixture"], *entry.get("support", [])]
    placed = PLACEMENT.place([(HERE / src, target_of(src)) for src in sources])
    try:
        proc = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, timeout=1200)
    finally:
        PLACEMENT.remove(placed)

    output = proc.stdout + proc.stderr
    marker = marker_of(entry["fixture"])
    if proc.returncode != 0 and marker in output:
        return Outcome(entry_id, "PASS", f"{gate_name} refused {marker}")
    tail = "\n".join(output.strip().splitlines()[-15:])
    return Outcome(
        entry_id,
        "FAIL",
        f"{gate_name} exit={proc.returncode}, output does not name {marker}\n  $ {' '.join(cmd)}\n{tail}",
    )


def main() -> int:
    manifest = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    gates = manifest["gates"]
    only = set(sys.argv[1:])
    entries = [e for e in manifest["entries"] if not only or e["id"] in only]
    jobs = max(1, int(os.environ.get("GATE_FIXTURES_JOBS", "4")))
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        outcomes = list(pool.map(lambda e: run_entry(e, gates), entries))

    for o in outcomes:
        print(f"[{o.status:<4}] {o.entry_id}: {o.detail}")
    passed = sum(o.status == "PASS" for o in outcomes)
    failed = len(outcomes) - passed
    print(f"gate fixtures: {passed} refused, {failed} failed")
    return 1 if failed or not outcomes else 0


if __name__ == "__main__":
    sys.exit(main())
