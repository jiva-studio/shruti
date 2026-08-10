#!/usr/bin/env python3
"""Enforce a coverage floor per package, not one line target for the service.

A single global `--fail-under` is exactly what would NOT have caught this
codebase's problem: the whole-service number was a respectable 76.7% while
individual packages sat near zero, because a large well-covered package pays
for a small untested one. Averages hide the packages nobody tested. A floor per
package fails the pull request that adds one.

Floors live in `pyproject.toml` under `[tool.coverage_floors]`, alongside the
coverage config they gate:

    _total_   whole-service rollup
    _root_    modules sitting directly in `src/shruti_chat/`
    _default_ any package without its own entry — so a NEW package cannot land
              at 0% simply by not being listed here

Usage (after `pytest --cov --cov-report=json`):

    python scripts/check_coverage_floors.py [coverage.json]

Exits non-zero, and prints every package with its floor, if any package is
below. When it fails the fix is a test, not a smaller number: the floors are
set UNDER the measured value on purpose and are meant to ratchet upward.
"""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
PACKAGE = "shruti_chat"
TOTAL_KEY = "_total_"
ROOT_KEY = "_root_"
DEFAULT_KEY = "_default_"


def load_floors() -> dict[str, float]:
    with (APP_ROOT / "pyproject.toml").open("rb") as fh:
        table = tomllib.load(fh).get("tool", {}).get("coverage_floors", {})
    if not table:
        sys.exit("no [tool.coverage_floors] table in pyproject.toml")
    return {name: float(value) for name, value in table.items()}


def package_of(path: str) -> str | None:
    """`src/shruti_chat/api/chat.py` -> `api`; a top-level module -> `_root_`."""
    parts = Path(path).as_posix().split("/")
    if PACKAGE not in parts:
        return None
    rest = parts[parts.index(PACKAGE) + 1 :]
    return rest[0] if len(rest) > 1 else ROOT_KEY


def tally(report: dict) -> dict[str, tuple[int, int]]:
    """package -> (covered statements, total statements)."""
    totals: dict[str, tuple[int, int]] = {}
    for path, data in report["files"].items():
        pkg = package_of(path)
        if pkg is None:
            continue
        summary = data["summary"]
        covered, statements = totals.get(pkg, (0, 0))
        totals[pkg] = (
            covered + summary["covered_lines"],
            statements + summary["num_statements"],
        )
    return totals


def main(argv: list[str]) -> int:
    report_path = Path(argv[1]) if len(argv) > 1 else APP_ROOT / "coverage.json"
    if not report_path.exists():
        sys.exit(f"{report_path} not found — run pytest with --cov-report=json first")

    report = json.loads(report_path.read_text())
    floors = load_floors()
    default = floors.get(DEFAULT_KEY)

    rows: list[tuple[str, float, float | None]] = []
    for pkg, (covered, statements) in tally(report).items():
        if statements == 0:
            continue
        rows.append((pkg, 100.0 * covered / statements, floors.get(pkg, default)))
    rows.sort(key=lambda row: row[1])

    overall = report["totals"]["percent_covered"]
    rows.append((TOTAL_KEY, overall, floors.get(TOTAL_KEY)))

    failures = [row for row in rows if row[2] is not None and row[1] < row[2]]

    width = max(len(row[0]) for row in rows)
    print(f"{'package'.ljust(width)}  coverage    floor")
    for pkg, pct, floor in rows:
        verdict = "" if floor is None or pct >= floor else "  BELOW FLOOR"
        shown = "     —" if floor is None else f"{floor:6.1f}"
        print(f"{pkg.ljust(width)}  {pct:7.1f}%  {shown}{verdict}")

    if failures:
        print()
        for pkg, pct, floor in failures:
            print(f"{pkg}: {pct:.1f}% is under its floor of {floor:.1f}%")
        print("\nAdd tests. Lowering a floor to go green defeats the point of having one.")
        return 1

    print("\nevery package is at or above its floor")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
