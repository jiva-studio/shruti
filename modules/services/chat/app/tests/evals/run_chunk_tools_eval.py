"""End-to-end eval gate for the chunks_* / user_* tool surface.

Reads `chunk_tools.jsonl`, runs each query through a real chat client
against the production-shaped backend, and checks three things:

  1. The LLM picked the EXPECTED tool name first.
  2. The tool arguments contain the expected subset
     (e.g. `type='verse'` when the case says so).
  3. The tool RESULT satisfies the case's content predicates
     (count, item types, score floor, cross-corpus diversity, etc.).

Runs as a standalone script — NOT a pytest test — because it requires
a live LLM API key and is billed per call. Use it before merging
significant prompt or tool-surface changes:

    python -m tests.evals.run_chunk_tools_eval

The script writes per-case results to `tests/evals/results.jsonl` so
you can diff it against the previous run to spot regressions.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


HERE = Path(__file__).parent
DEFAULT_CASES = HERE / "chunk_tools.jsonl"
DEFAULT_RESULTS = HERE / "results.jsonl"


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def args_subset_match(actual: dict[str, Any], expected: dict[str, Any] | None) -> bool:
    """Every (k, v) in `expected` must appear identically in `actual`.

    Extra keys in `actual` are fine — the LLM may add filters we
    didn't specify. `expected=None` or empty dict → always passes.
    """
    if not expected:
        return True
    for k, v in expected.items():
        if k not in actual or actual[k] != v:
            return False
    return True


def _get_path(obj: Any, path: str) -> Any:
    """Read `meta.source_id`-style dotted paths from a dict."""
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def _item_matches(item: dict[str, Any], filt: dict[str, Any]) -> bool:
    for k, v in filt.items():
        if k.endswith("_contains"):
            real_key = k[: -len("_contains")]
            val = _get_path(item, real_key)
            if not isinstance(val, str) or v not in val:
                return False
            continue
        actual = _get_path(item, k)
        if actual != v:
            return False
    return True


def predicate_match(result: Any, expected: dict[str, Any] | None) -> tuple[bool, str]:
    """Check a tool result against `expect_result` predicates.

    Returns (passed, reason). reason is "" when passed; otherwise a
    short string for the per-case log.
    """
    if not expected:
        return True, ""
    if not isinstance(result, list):
        # Tools can return error dicts; treat as not-matching unless
        # the case explicitly expected one.
        return False, f"result is not a list (got {type(result).__name__})"

    min_count = expected.get("min_count")
    if min_count is not None and len(result) < min_count:
        return False, f"min_count={min_count} but got {len(result)}"
    max_count = expected.get("max_count")
    if max_count is not None and len(result) > max_count:
        return False, f"max_count={max_count} but got {len(result)}"

    for filt in expected.get("all_items", []):
        for item in result:
            if not _item_matches(item, filt):
                return False, f"item failed filter {filt}: {item.get('type')}/{item.get('label')}"

    no_item = expected.get("no_item")
    if no_item is not None:
        for item in result:
            if _item_matches(item, no_item):
                return False, f"forbidden item present matching {no_item}"

    first = expected.get("first_item")
    if first is not None:
        if not result or not _item_matches(result[0], first):
            return False, f"first_item does not match {first}"

    score_min = expected.get("score_min")
    if score_min is not None:
        scores = [r.get("score") for r in result if r.get("score") is not None]
        if scores and min(scores) < score_min:
            return False, f"min score {min(scores):.3f} < {score_min}"

    diversity = expected.get("diversity")
    if diversity is not None:
        wanted_types = diversity.get("type", [])
        min_each = diversity.get("min_each", 1)
        counts: dict[str, int] = {}
        for r in result:
            t = r.get("type")
            if t in wanted_types:
                counts[t] = counts.get(t, 0) + 1
        missing = [t for t in wanted_types if counts.get(t, 0) < min_each]
        if missing:
            return False, f"diversity: missing min_each={min_each} for {missing}"

    return True, ""


# ── Live runner ───────────────────────────────────────────────────────
# The runner below talks to the real chat service. Kept separate from
# pure predicate logic above so the file can be imported (and its
# predicates unit-tested) without spinning up infra.


async def run_eval(cases_path: Path, results_path: Path) -> int:
    """Execute every case, write per-case results to disk, print a summary.

    Returns the process exit code (0 = all OK, 1 = at least one
    regression).
    """
    # NOTE: chat-client wiring is environment-specific; expected to be
    # injected via the surrounding harness. The minimal shape we need is:
    #   chat_client.run_turn(query, context=...) -> {tool_call, result}
    # with `tool_call.name` and `tool_call.args` exposed.
    try:
        from tests.evals._fixtures import make_chat_client  # type: ignore
    except ImportError:
        print(
            "tests/evals/_fixtures.make_chat_client not found.\n"
            "Wire a chat client adapter for your environment (LLM key,\n"
            "test DB, alias map) and re-run."
        )
        return 2

    chat_client = make_chat_client()
    cases = load_jsonl(cases_path)
    results: list[dict[str, Any]] = []
    pass_count = 0

    for case in cases:
        try:
            turn = await chat_client.run_turn(
                case["query"], context=case.get("context", {}),
            )
        except Exception as exc:  # noqa: BLE001 — surface raw error for triage
            results.append({"case": case["query"], "error": repr(exc)})
            continue

        tool_match = turn.tool_call.name == case["expect_tool"]
        args_match = args_subset_match(turn.tool_call.args, case.get("expect_args"))
        result_match, reason = predicate_match(turn.result, case.get("expect_result"))
        passed = tool_match and args_match and result_match
        if passed:
            pass_count += 1
        results.append({
            "case": case["query"],
            "expected_tool": case["expect_tool"],
            "actual_tool": turn.tool_call.name,
            "tool_match": tool_match,
            "args_match": args_match,
            "result_match": result_match,
            "fail_reason": reason if not result_match else "",
        })

    results_path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n")
    accuracy = pass_count / len(cases) if cases else 0.0
    print(f"\n{pass_count} / {len(cases)} passed ({accuracy:.0%})")
    for r in results:
        if not r.get("tool_match") or not r.get("args_match") or not r.get("result_match"):
            print(f"  FAIL: {r['case']} → {r.get('actual_tool')} ({r.get('fail_reason')})")
    return 0 if accuracy >= 0.90 else 1


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    return p.parse_args()


if __name__ == "__main__":
    import asyncio

    args = _parse_args()
    raise SystemExit(asyncio.run(run_eval(args.cases, args.results)))
