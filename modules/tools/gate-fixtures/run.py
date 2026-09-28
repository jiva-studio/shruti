"""Proves that each authoritative architecture gate refuses a known violation.

Every entry in manifest.json names a fixture — one file breaking one rule — and
the gate that must refuse it. For each entry the fixture is copied to the place
in the tree it names (the path under ts/, py/ or go/ is the repository-relative
target), the gate runs, and the fixture is removed again. The entry passes when
the gate exits non-zero and its output names the fixture.

An entry is `active` or `pending`. A pending entry names a gate that is not in
the tree yet; its `activate_when` condition says what the gate looks like once
it is, and from that moment the entry runs like an active one.

A gate whose tool is not installed fails the entry under CI (or with
GATE_FIXTURES_REQUIRE_ALL=1) and is reported as unavailable otherwise.

Standard library only; run with `uv run --no-project python`.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
STACK_DIRS = ("ts/", "py/", "go/")


@dataclass
class Outcome:
    entry_id: str
    status: str  # PASS | FAIL | PENDING | UNAVAILABLE
    detail: str


def require_all() -> bool:
    return os.environ.get("GATE_FIXTURES_REQUIRE_ALL") == "1" or os.environ.get("CI") == "true"


def target_of(fixture: str) -> Path:
    for prefix in STACK_DIRS:
        if fixture.startswith(prefix):
            return REPO_ROOT / fixture[len(prefix) :]
    raise ValueError(f"fixture path must start with one of {STACK_DIRS}: {fixture}")


def marker_of(fixture: str) -> str:
    """The path component the gate's output must name."""
    return next(part for part in Path(fixture).parts if "gatefixture" in part)


def find_config(gate: dict) -> Path | None:
    for candidate in gate.get("config_candidates", []):
        path = REPO_ROOT / candidate
        if path.is_file():
            return path
    return None


def is_active(entry: dict, gates: dict) -> bool:
    if entry["status"] == "active":
        return True
    cond = entry.get("activate_when") or {}
    if "any_exists" in cond:
        ref = cond["any_exists"]
        gate_name = ref.removeprefix("gate:")
        return find_config(gates[gate_name]) is not None
    if "file" in cond:
        path = REPO_ROOT / cond["file"]
        return path.is_file() and re.search(cond["matches"], path.read_text(encoding="utf-8")) is not None
    return False


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
    config = find_config(gate)
    if config is not None:
        values["config"] = str(config)
        values["config_dir"] = str(config.parent)
    if target.suffix == ".go":
        module = go_module_dir(target)
        values["module_dir"] = str(module)
        values["package_rel"] = str(target.parent.relative_to(module))
    workdir_raw = gate["workdir"].format(**values)
    workdir = Path(workdir_raw) if Path(workdir_raw).is_absolute() else REPO_ROOT / workdir_raw
    values["path"] = entry.get("path") or os.path.relpath(target, workdir)
    return [part.format(**values) for part in gate["command"]], workdir


def tool_available(cmd: list[str], workdir: Path) -> str | None:
    exe = cmd[0]
    if shutil.which(exe) is None and not Path(exe).is_file():
        return f"{exe} not installed"
    if exe == "npx" and not (workdir / "node_modules").is_dir():
        mobile_modules = REPO_ROOT / "modules" / "apps" / "mobile" / "node_modules"
        if not mobile_modules.is_dir():
            return "node_modules not installed (npm ci)"
    return None


def place(fixture_src: Path, target: Path) -> list[Path]:
    """Copy the fixture in; return what was created, deepest first."""
    if target.exists():
        raise FileExistsError(f"refusing to overwrite {target}")
    created: list[Path] = []
    missing = [p for p in reversed(target.parents) if not p.exists()]
    for directory in missing:
        directory.mkdir()
        created.append(directory)
    shutil.copyfile(fixture_src, target)
    created.append(target)
    return list(reversed(created))


def remove(created: list[Path]) -> None:
    for path in created:
        if path.is_dir():
            path.rmdir()
        elif path.exists():
            path.unlink()


def run_entry(entry: dict, gates: dict) -> Outcome:
    entry_id = entry["id"]
    gate_name = entry["gate"]
    gate = gates[gate_name]
    if not is_active(entry, gates):
        return Outcome(entry_id, "PENDING", f"{gate_name}: the rule is not in the tree yet")

    fixture_src = HERE / entry["fixture"]
    target = target_of(entry["fixture"])
    cmd, workdir = build_command(entry, gate, target)
    missing = tool_available(cmd, workdir)
    if missing:
        status = "FAIL" if require_all() else "UNAVAILABLE"
        return Outcome(entry_id, status, f"{gate_name}: {missing}")

    created = place(fixture_src, target)
    try:
        proc = subprocess.run(cmd, cwd=workdir, capture_output=True, text=True, timeout=1200)
    finally:
        remove(created)

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
    outcomes = [run_entry(e, gates) for e in manifest["entries"] if not only or e["id"] in only]

    for o in outcomes:
        print(f"[{o.status:<11}] {o.entry_id}: {o.detail}")
    counts = {s: sum(o.status == s for o in outcomes) for s in ("PASS", "FAIL", "PENDING", "UNAVAILABLE")}
    print(
        f"gate fixtures: {counts['PASS']} refused, {counts['FAIL']} failed, "
        f"{counts['PENDING']} pending, {counts['UNAVAILABLE']} unavailable"
    )
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
