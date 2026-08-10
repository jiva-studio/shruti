#!/usr/bin/env python3
"""Adaptive-pipeline eval harness (issue #1068).

Fires the dataset's queries at a running chat stack over SSE, parses the
stream + correlates per-turn pipeline logs by trace id, and writes a report
with the metrics that gate the SHORT/LONG → adaptive change:

  - path            short | long           (which fork ran today)
  - memory_matched  + memory_refs          (curator memory resolved this turn)
  - n_sources       research_source count  (pool size — the dilution proxy)
  - gold_cited / N  curated shlokas the answer actually cited (done.aliases)
  - verses_cited    distinct verse citations
  - latency_s, answer_chars, tokens

Run it ONCE against the baseline (origin/main container) to capture the
before numbers, then again against the new pipeline; `compare.py` diffs the
two reports into the PR table.

    python eval/run_eval.py --tag baseline --out eval/reports/baseline.json
    python eval/run_eval.py --tag baseline --only memory_correct      # subset

Correlation: each turn sends a generated X-Trace-Id; the chat logs print it
as `langfuse_trace_id`, so path/memory are read back deterministically (no
timing heuristics). Requires the local stack up (see the local-stack skill)
and the JWT signing key the stack verifies with.

Minting/firing/stream-splitting live in `sse_probe.py`, shared with the
chat-sse-probe skill; this file only adds the eval-specific scoring.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from sse_probe import delta_text, iter_events, mint_token, new_trace_id
from sse_probe import fire as fire_turn

# BG source id in the corpus — the curated memory's 8 shlokas all live here,
# so a cited verse alias is "gold" iff (source==BG and token in the gold set).
BG_SOURCE_ID = "source_dsicuBsFvinZ"

# Defaults target the baseline (origin/main) container; override with
# --url / --container to point at the worktree twin (see project memory
# `run_chat_worktree_locally`).
CHAT_URL = "http://localhost:11080/chat"
CHAT_CONTAINER = "lectorium-chat-1"
HERE = Path(__file__).resolve().parent


def parse_sse(raw: str, gold_tokens: set[str]) -> dict:
    ev = iter_events(raw)
    n_sources = sum(1 for k, _ in ev if k == "research_source")
    answer = delta_text(ev)

    cited_verse_tokens: set[str] = set()
    alias_kinds: dict[str, int] = {}
    usage_tokens = None
    error = None
    for k, d in ev:
        if k == "done":
            try:
                aliases = json.loads(d).get("aliases", {})
            except Exception:
                aliases = {}
            for a in aliases.values():
                kind = a.get("kind")
                alias_kinds[kind] = alias_kinds.get(kind, 0) + 1
                if kind == "verse" and a.get("source_id") == BG_SOURCE_ID:
                    cited_verse_tokens.add(a.get("tokens"))
        elif k == "usage":
            try:
                usage_tokens = json.loads(d)
            except Exception:
                pass
        elif k == "error":
            error = d[:200]

    gold_cited = sorted(gold_tokens & cited_verse_tokens) if gold_tokens else []
    return {
        "n_sources": n_sources,
        "verses_cited": sorted(cited_verse_tokens),
        "gold_cited": gold_cited,
        "gold_cited_n": len(gold_cited),
        "alias_kinds": {k: v for k, v in alias_kinds.items() if k},
        "answer_chars": len(answer),
        "answer": answer,
        "usage": usage_tokens,
        "error": error,
        "events": {k: sum(1 for kk, _ in ev if kk == k) for k in {kk for kk, _ in ev}},
    }


def read_pipeline_logs(trace_id: str) -> dict:
    """Pull the per-turn pipeline facts the SSE doesn't expose, keyed by the
    trace id printed as `langfuse_trace_id`."""
    proc = subprocess.run(
        ["docker", "logs", CHAT_CONTAINER, "--since", "3m"],
        capture_output=True, text=True,
    )
    out = proc.stdout + proc.stderr  # structlog stream varies by config
    info = {"path": None, "memory_matched": False, "memory_refs": 0,
            "short_top_score": None, "topic_matches": None}
    for line in out.splitlines():
        if trace_id not in line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        msg = rec.get("message")
        if msg == "pipeline_short_path":
            info["path"] = "short"
            info["short_top_score"] = rec.get("top_score")
        elif msg == "pipeline_lean_path":   # new adaptive pipeline (CORRECT bucket)
            info["path"] = "lean"
            info["short_top_score"] = rec.get("top_score")
            info["pinned_matches"] = rec.get("pinned_matches")
        elif msg == "pipeline_long_path":
            info["path"] = "long"
            info["topic_matches"] = rec.get("topic_matches")
        elif msg == "pipeline_memory_match":
            info["memory_matched"] = True
            info["memory_refs"] = rec.get("refs", 0)
            info["memory_score"] = rec.get("score")
    return info


def main() -> int:
    global CHAT_URL, CHAT_CONTAINER
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(HERE / "dataset.json"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--tag", default="run")
    ap.add_argument("--only", default=None, help="filter by bucket or id substring")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--sleep", type=float, default=1.5, help="gap between turns")
    ap.add_argument("--url", default=CHAT_URL, help="chat /chat endpoint")
    ap.add_argument("--container", default=CHAT_CONTAINER, help="chat container for log correlation")
    args = ap.parse_args()
    CHAT_URL, CHAT_CONTAINER = args.url, args.container

    ds = json.loads(Path(args.dataset).read_text())
    gold_sets = {
        name: {v.split()[-1] for v in g["verses"]}
        for name, g in ds["gold_sets"].items()
    }
    queries = ds["queries"]
    if args.only:
        queries = [q for q in queries if args.only in q["bucket"] or args.only in q["id"]]
    if args.limit:
        queries = queries[: args.limit]

    token = mint_token(sub="eval-probe", ttl=3600)
    results = []
    for i, q in enumerate(queries, 1):
        gold_tokens = gold_sets.get(q.get("gold")) if q.get("gold") else set()
        trace = new_trace_id()
        print(f"[{i}/{len(queries)}] {q['id']:14s} {q['q'][:50]}", file=sys.stderr)
        raw, wall = fire_turn(CHAT_URL, token, trace, q["q"], q["lang"])
        m = parse_sse(raw, gold_tokens or set())
        time.sleep(0.4)  # let structlog flush
        logs = read_pipeline_logs(trace)
        row = {
            "id": q["id"], "bucket": q["bucket"], "q": q["q"], "lang": q["lang"],
            "gold": q.get("gold"), "gold_total": len(gold_tokens or []),
            "expect_path": q.get("expect_path"),
            "trace": trace, "latency_s": round(wall, 1),
            **logs, **m,
        }
        results.append(row)
        gold_str = f"{row['gold_cited_n']}/{row['gold_total']}" if row["gold_total"] else "-"
        print(f"    path={logs['path']} mem={logs['memory_matched']}({logs['memory_refs']}) "
              f"src={m['n_sources']} gold={gold_str} lat={row['latency_s']}s",
              file=sys.stderr)
        time.sleep(args.sleep)

    out_path = Path(args.out) if args.out else HERE / "reports" / f"{args.tag}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"tag": args.tag, "results": results}, ensure_ascii=False, indent=2))
    print(f"\nwrote {out_path}  ({len(results)} turns)", file=sys.stderr)
    _summary(results)
    return 0


def _summary(results: list[dict]) -> None:
    from collections import defaultdict
    by_bucket = defaultdict(list)
    for r in results:
        by_bucket[r["bucket"]].append(r)
    print("\n=== summary by bucket ===")
    print(f"{'bucket':22s} {'n':>2s} {'short/long':>10s} {'mem%':>5s} {'avg_src':>7s} {'gold':>8s} {'avg_lat':>7s}")
    for bucket, rows in by_bucket.items():
        n = len(rows)
        short = sum(1 for r in rows if r["path"] in ("short", "lean"))
        long = sum(1 for r in rows if r["path"] == "long")
        memp = round(100 * sum(1 for r in rows if r["memory_matched"]) / n)
        avg_src = round(sum(r["n_sources"] for r in rows) / n, 1)
        avg_lat = round(sum(r["latency_s"] for r in rows) / n, 1)
        gold_rows = [r for r in rows if r["gold_total"]]
        if gold_rows:
            gnum = sum(r["gold_cited_n"] for r in gold_rows)
            gden = sum(r["gold_total"] for r in gold_rows)
            gold = f"{gnum}/{gden}"
        else:
            gold = "-"
        print(f"{bucket:22s} {n:>2d} {f'{short}/{long}':>10s} {memp:>4d}% {avg_src:>7.1f} {gold:>8s} {avg_lat:>6.1f}s")


if __name__ == "__main__":
    raise SystemExit(main())
