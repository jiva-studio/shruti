#!/usr/bin/env python3
"""Diff two eval reports (baseline vs new) into a before/after markdown table.

    python eval/compare.py eval/reports/baseline.json eval/reports/phase1.json

Joins by query id and reports, per bucket, the metrics that gate #1068:
path mix, pool size (dilution proxy), gold citation depth, latency. Curated
citation depth MUST NOT regress; pool size + latency SHOULD drop on
memory/pinned-answered turns.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict


def load(path: str) -> dict[str, dict]:
    data = json.loads(open(path, encoding="utf-8").read())
    return {r["id"]: r for r in data["results"]}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    base, new = load(sys.argv[1]), load(sys.argv[2])
    ids = [i for i in base if i in new]

    by_bucket: dict[str, list[str]] = defaultdict(list)
    for i in ids:
        by_bucket[base[i]["bucket"]].append(i)

    def agg(rows: list[dict]) -> dict:
        n = len(rows)
        gold_rows = [r for r in rows if r.get("gold_total")]
        return {
            "short": sum(1 for r in rows if r["path"] == "short"),
            "long": sum(1 for r in rows if r["path"] == "long"),
            "lean": sum(1 for r in rows if r["path"] == "lean"),
            "avg_src": sum(r["n_sources"] for r in rows) / n if n else 0,
            "avg_lat": sum(r["latency_s"] for r in rows) / n if n else 0,
            "gold_num": sum(r["gold_cited_n"] for r in gold_rows),
            "gold_den": sum(r["gold_total"] for r in gold_rows),
        }

    print("## Baseline → Phase eval (before → after)\n")
    print("| bucket | n | path before→after | avg sources | gold cited | avg latency |")
    print("|---|--:|---|---|---|---|")
    for bucket, bids in by_bucket.items():
        b = agg([base[i] for i in bids])
        a = agg([new[i] for i in bids])
        path_b = f"{b['short']}s/{b['long']}l"
        path_a = f"{a['short']+a['lean']}s/{a['long']}l"
        gold = "—"
        if b["gold_den"]:
            gold = f"{b['gold_num']}/{b['gold_den']} → {a['gold_num']}/{a['gold_den']}"
        print(f"| {bucket} | {len(bids)} | {path_b} → {path_a} | "
              f"{b['avg_src']:.0f} → {a['avg_src']:.0f} | {gold} | "
              f"{b['avg_lat']:.1f}s → {a['avg_lat']:.1f}s |")

    # Per-query regressions in gold citation (the must-not-regress invariant).
    print("\n### Gold citation per query (curated buckets)")
    regressions = []
    for i in ids:
        if not base[i].get("gold_total"):
            continue
        gb, ga = base[i]["gold_cited_n"], new[i]["gold_cited_n"]
        flag = "  ⚠️ REGRESSION" if ga < gb else ("  ✅" if ga >= gb else "")
        if ga < gb:
            regressions.append(i)
        print(f"- {i:14s} {base[i]['path']}→{new[i]['path']}  "
              f"src {base[i]['n_sources']}→{new[i]['n_sources']}  "
              f"gold {gb}/{base[i]['gold_total']}→{ga}/{new[i]['gold_total']}"
              f"  lat {base[i]['latency_s']}→{new[i]['latency_s']}s{flag}")
    print(f"\n{'⚠️ ' + str(len(regressions)) + ' regression(s): ' + ', '.join(regressions) if regressions else '✅ no gold-citation regressions'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
