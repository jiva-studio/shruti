#!/usr/bin/env python3
"""Blind A/B LLM judge over two eval reports (issue #1068, Phase 6).

For each query present in both reports, presents the two answers to an opus
judge in randomised A/B order (blind — the judge never learns which is baseline
vs new) and asks it to score faithfulness / completeness / structure / balance
and pick the better answer. Aggregates win/loss/tie per bucket.

    python eval/judge.py eval/reports/baseline.json eval/reports/after.json

Pairs with the deterministic `compare.py`: that proves citation depth held and
pool/latency dropped; this checks the prose didn't regress where the retrieval
path changed (memory LONG→lean, multi-facet). The OpenRouter key is read from
the chat env file; no secret is printed.

Deterministic by construction: the A/B side assignment is seeded from the query
id (no RNG), so re-runs are stable and reproducible.
"""
from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

MODEL = "anthropic/claude-opus-4.8"
ENV_FILE = "/tmp/chat-eval.env"
OR_URL = "https://openrouter.ai/api/v1/chat/completions"

RUBRIC = """You are a strict evaluator of answers from a Vaishnava scripture
study assistant (Bhagavad-gita / Srimad-Bhagavatam, Prabhupada's teaching).

Question:
{q}

Two answers, A and B (you do NOT know which system produced which):

--- ANSWER A ---
{a}

--- ANSWER B ---
{b}

Judge on:
- faithfulness: claims grounded in the tradition, no fabrication
- completeness: covers the question's facets (if multi-part, both parts)
- structure: clear, well-organised, cites verses where relevant
- balance: not one-sided where the tradition is nuanced

Return ONLY a JSON object:
{{"winner": "A" | "B" | "tie", "faithfulness": "A|B|tie",
  "completeness": "A|B|tie", "reason": "<one sentence>"}}"""


def or_key() -> str:
    for line in Path(ENV_FILE).read_text().splitlines():
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1]
    raise SystemExit("OPENROUTER_API_KEY not found in env file")


def call_judge(key: str, q: str, a: str, b: str) -> dict:
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": RUBRIC.format(q=q, a=a, b=b)}],
        "temperature": 0,
        "max_tokens": 400,
    }).encode()
    req = urllib.request.Request(
        OR_URL, data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.load(resp)
    txt = out["choices"][0]["message"]["content"]
    m = txt[txt.find("{"): txt.rfind("}") + 1]
    return json.loads(m)


def side_for(qid: str) -> bool:
    # Deterministic A/B assignment from the id: True ⇒ baseline is shown as A.
    return int(hashlib.sha1(qid.encode()).hexdigest(), 16) % 2 == 0


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    base = {r["id"]: r for r in json.loads(Path(sys.argv[1]).read_text())["results"]}
    new = {r["id"]: r for r in json.loads(Path(sys.argv[2]).read_text())["results"]}
    key = or_key()

    from collections import defaultdict
    tally: dict[str, dict[str, int]] = defaultdict(lambda: {"new": 0, "base": 0, "tie": 0})
    rows = []
    for qid in base:
        if qid not in new:
            continue
        ab, an = base[qid].get("answer", ""), new[qid].get("answer", "")
        if not ab.strip() or not an.strip():
            continue
        base_is_a = side_for(qid)
        a_txt, b_txt = (ab, an) if base_is_a else (an, ab)
        try:
            v = call_judge(key, base[qid]["q"], a_txt, b_txt)
        except Exception as exc:  # noqa: BLE001
            print(f"  {qid}: judge error {exc}", file=sys.stderr)
            continue
        win = v.get("winner")
        if win == "tie":
            verdict = "tie"
        else:
            base_won = (win == "A") == base_is_a
            verdict = "base" if base_won else "new"
        tally[base[qid]["bucket"]][verdict] += 1
        rows.append((qid, base[qid]["bucket"], verdict, v.get("reason", "")))
        print(f"  {qid:14s} {verdict:4s}  {v.get('reason','')[:80]}", file=sys.stderr)

    print("\n## LLM judge (opus, blind A/B) — new vs baseline\n")
    print("| bucket | new wins | baseline wins | tie |")
    print("|---|--:|--:|--:|")
    for bucket, t in tally.items():
        print(f"| {bucket} | {t['new']} | {t['base']} | {t['tie']} |")
    tot_new = sum(t["new"] for t in tally.values())
    tot_base = sum(t["base"] for t in tally.values())
    tot_tie = sum(t["tie"] for t in tally.values())
    print(f"\n**Total: new {tot_new} / baseline {tot_base} / tie {tot_tie}** "
          f"(judged {tot_new + tot_base + tot_tie} pairs, model {MODEL})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
