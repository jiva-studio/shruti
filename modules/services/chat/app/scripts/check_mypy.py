#!/usr/bin/env python3
"""Fail on the mypy findings that mean "this name does not exist".

The service is not type-clean, and adopting full mypy is a separate project.
What IS cheap and decisive is the subset of errors where the code refers to
something that is not there — a function a module no longer exports, a
misspelled attribute, an import of a deleted module. Those crash at runtime,
often only on a path the tests do not execute (the service lifespan is one).

Gated error codes:

    attr-defined      `module.name` / `obj.attr` that does not exist
    name-defined      a bare name that is not bound
    import-not-found  an import of a module that is not on the path

Every other mypy finding is printed as a count and does not fail the run.
Configuration (files, `follow_imports`) lives in pyproject's `[tool.mypy]`.

Usage, from `modules/services/chat/app`:

    uv run python scripts/check_mypy.py
"""

from __future__ import annotations

import re
import sys
from collections import Counter

from mypy import api

GATED_CODES = frozenset({"attr-defined", "name-defined", "import-not-found"})

_ERROR_RE = re.compile(r"^(?P<loc>[^:]+:\d+(?::\d+)?): error: .*\[(?P<code>[a-z-]+)\]$")


def main() -> int:
    stdout, stderr, status = api.run(["--no-error-summary"])
    if status not in (0, 1):
        # 2 = mypy itself failed (bad config, crash): never a pass.
        sys.stderr.write(stderr or stdout)
        return 2

    gated: list[str] = []
    other: Counter[str] = Counter()
    for line in stdout.splitlines():
        match = _ERROR_RE.match(line)
        if not match:
            continue
        code = match.group("code")
        if code in GATED_CODES:
            gated.append(line)
        else:
            other[code] += 1

    if other:
        summary = ", ".join(f"{code}={n}" for code, n in sorted(other.items()))
        print(f"mypy: not gated ({sum(other.values())}): {summary}")
    if gated:
        print(f"mypy: {len(gated)} gated error(s) — {', '.join(sorted(GATED_CODES))}:")
        for line in gated:
            print(f"  {line}")
        return 1
    print("mypy: no gated errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
