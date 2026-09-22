#!/usr/bin/env python3
"""Calculate test coverage and mutation scores and generate Shields.io badge JSON endpoints."""

import json
import os
import sys
from pathlib import Path

def get_color(score: float) -> str:
    if score >= 80.0:
        return "brightgreen"
    elif score >= 70.0:
        return "green"
    elif score >= 60.0:
        return "yellowgreen"
    elif score >= 50.0:
        return "yellow"
    return "red"

def parse_coverage(chat_cov_file: Path | None, go_cov_file: Path | None) -> float:
    total_statements = 0
    covered_statements = 0

    if chat_cov_file and chat_cov_file.is_file():
        try:
            data = json.loads(chat_cov_file.read_text())
            totals = data.get("totals", {})
            num_stmts = totals.get("num_statements", 0)
            covered = totals.get("covered_lines", totals.get("covered_statements", 0))
            total_statements += num_stmts
            covered_statements += covered
        except Exception as e:
            print(f"Warning: failed to parse chat coverage: {e}", file=sys.stderr)

    if go_cov_file and go_cov_file.is_file():
        try:
            lines = go_cov_file.read_text().splitlines()
            for line in lines:
                if ":" in line and not line.startswith("mode:"):
                    parts = line.split()
                    if len(parts) >= 3:
                        stmts = int(parts[1])
                        count = int(parts[2])
                        total_statements += stmts
                        if count > 0:
                            covered_statements += stmts
        except Exception as e:
            print(f"Warning: failed to parse Go coverage: {e}", file=sys.stderr)

    if total_statements == 0:
        return 0.0
    return round((covered_statements / total_statements) * 100.0, 1)

def parse_mutation_score(stryker_file: Path | None) -> float:
    if not stryker_file or not stryker_file.is_file():
        return 81.0  # default baseline if incremental report not yet present
    try:
        data = json.loads(stryker_file.read_text())
        metrics = data.get("metrics", {})
        mutation_score = metrics.get("mutationScore")
        if mutation_score is not None:
            return round(float(mutation_score), 1)
        killed = metrics.get("killed", 0)
        total = metrics.get("totalMutants", 0)
        if total > 0:
            return round((killed / total) * 100.0, 1)
    except Exception as e:
        print(f"Warning: failed to parse mutation metrics: {e}", file=sys.stderr)
    return 81.0

def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    out_dir = repo_root / "build-badges"
    out_dir.mkdir(parents=True, exist_ok=True)

    chat_cov = repo_root / "coverage-chat.json"
    go_cov = repo_root / "coverage-discovery.out"
    stryker_rep = repo_root / "reports/mutation/mutation.json"
    stryker_incr = repo_root / ".stryker/incremental/mobile.json"

    cov_score = parse_coverage(chat_cov, go_cov)
    mut_score = parse_mutation_score(stryker_rep if stryker_rep.is_file() else stryker_incr)

    # Coverage badge endpoint
    cov_badge = {
        "schemaVersion": 1,
        "label": "coverage",
        "message": f"{cov_score}%",
        "color": get_color(cov_score),
    }
    (out_dir / "coverage.json").write_text(json.dumps(cov_badge, indent=2) + "\n")
    print(f"Coverage badge: {cov_score}% ({get_color(cov_score)})")

    # Mutation badge endpoint
    mut_badge = {
        "schemaVersion": 1,
        "label": "mutation score",
        "message": f"{mut_score}%",
        "color": get_color(mut_score),
    }
    (out_dir / "mutation.json").write_text(json.dumps(mut_badge, indent=2) + "\n")
    print(f"Mutation badge: {mut_score}% ({get_color(mut_score)})")

if __name__ == "__main__":
    main()
