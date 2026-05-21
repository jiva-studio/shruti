"""End-to-end eval gate for the chunks_* / user_* tool surface AND the
multi-agent graph (router → workers → synthesizer).

Reads `chunk_tools.jsonl`, runs each query through a real chat client
against the production-shaped backend, and checks any combination of:

  Tool-level predicates (single-tool legacy + multi-tool chain):
  - `expect_tool`        — name of the FIRST tool called
  - `expect_args`        — args of the first tool (subset match)
  - `expect_result`      — content predicates on first tool's result
                           (min_count, all_items, diversity, ...)
  - `expect_tool_chain`  — ordered subsequence of tool names; LLM may
                           add extras in between, but every name in the
                           list must appear in order
  - `expect_no_tool`     — no tools called at all (direct_chat path)

  Router-level predicates:
  - `expect_intent`      — router's RoutingDecision.intent

  Synthesizer-level predicates:
  - `expect_no_marker_kind`        — assert NO `[<kind>:...]` marker
                                     in the response (e.g. commentary
                                     must be inline blockquote, not cite)
  - `expect_response_contains`     — list of substrings, ANY of which must
                                     appear (case-insensitive)
  - `expect_response_contains_marker` — "blockquote" → markdown `>`,
                                        or marker kind like "cite"

Runs as a standalone script — NOT a pytest test — because it requires
a live LLM API key and is billed per call. Use it before merging
significant prompt or graph changes:

    python -m tests.evals.run_chunk_tools_eval

The script writes per-case results to `tests/evals/results.jsonl` so
you can diff it against the previous run to spot regressions.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
from pathlib import Path
from typing import Any

from tests.evals.observation import (
    TurnObservation,
    has_blockquote,
    has_marker_kind,
)


HERE = Path(__file__).parent
DEFAULT_CASES = HERE / "chunk_tools.jsonl"
DEFAULT_RESULTS = HERE / "results.jsonl"


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    # Drop comment-shaped entries (lines whose only key is "_comment").
    out: list[dict[str, Any]] = []
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        obj = json.loads(line)
        if isinstance(obj, dict) and set(obj.keys()) == {"_comment"}:
            continue
        out.append(obj)
    return out


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


# ── Multi-agent predicates (operate on TurnObservation) ──────────────────


def _check_intent(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    expected = case.get("expect_intent")
    if expected is None:
        return []
    if obs.intent != expected:
        return [f"intent: expected={expected!r}, got={obs.intent!r}"]
    return []


def _check_no_tool(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    if not case.get("expect_no_tool"):
        return []
    if obs.tool_chain:
        return [f"expect_no_tool but got {obs.tool_names!r}"]
    return []


def _check_first_tool(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    expected = case.get("expect_tool")
    if expected is None:
        return []
    actual = obs.first_tool.name if obs.first_tool else None
    if actual != expected:
        return [f"expect_tool: expected={expected!r}, got={actual!r}"]
    return []


def _check_first_tool_args(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    expected = case.get("expect_args")
    if expected is None:
        return []
    if obs.first_tool is None:
        return ["expect_args set but no tool called"]
    if not args_subset_match(obs.first_tool.args, expected):
        return [
            f"args: expected subset {expected!r} not in {obs.first_tool.args!r}"
        ]
    return []


def _check_first_tool_result(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    """Check `expect_result` against the relevant tool's output.

    Picks the tool to inspect like this:
    - If `expect_tool` is set: the first invocation of that named tool.
    - Else if `expect_tool_chain` is set: the first invocation whose
      name appears in the chain (skip helper tools like
      `resolve_author` that aren't asserted in the chain).
    - Else: the very first tool called.

    Without this resolution, queries that legitimately need a helper
    tool first (`resolve_author` → `chunks_search`) would fail
    `expect_result` checks because the helper's result doesn't match
    the search-result shape.
    """
    expected = case.get("expect_result")
    if expected is None:
        return []
    target_name = case.get("expect_tool")
    target_chain = case.get("expect_tool_chain") or []
    target: Any = None
    if target_name:
        target = next((t for t in obs.tool_chain if t.name == target_name), None)
    elif target_chain:
        target = next((t for t in obs.tool_chain if t.name in target_chain), None)
    if target is None:
        target = obs.first_tool
    if target is None:
        return ["expect_result set but no tool called"]
    ok, reason = predicate_match(target.result, expected)
    return [f"result: {reason}"] if not ok else []


def _check_tool_chain(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    """Ordered subsequence match: every name in `expect_tool_chain`
    must appear in `obs.tool_names` in the same order. The LLM may
    insert helper tools in between — that's fine; we care that the
    expected progression happened."""
    expected = case.get("expect_tool_chain")
    if expected is None:
        return []
    actual = obs.tool_names
    i = 0
    for name in expected:
        try:
            i = actual.index(name, i) + 1
        except ValueError:
            return [
                f"tool_chain: expected subsequence {expected!r}, "
                f"got {actual!r} — missing {name!r} at/after position {i}"
            ]
    return []


def _check_no_marker_kind(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    kind = case.get("expect_no_marker_kind")
    if not kind:
        return []
    if has_marker_kind(obs.response_text, kind):
        return [
            f"expect_no_marker_kind={kind!r} but response contains it: "
            f"{_excerpt_markers(obs.response_text, kind)}"
        ]
    return []


def _excerpt_markers(text: str, kind: str, max_items: int = 3) -> list[str]:
    """First few matches of `[<kind>:...]` for the failure message."""
    pat = re.compile(rf"\[{re.escape(kind)}:[^\]\n]+\]")
    return pat.findall(text)[:max_items]


def _check_response_contains(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    """ANY-of semantics: the list is a set of acceptable phrasings (e.g.
    refusal synonyms `["could not find", "couldn't find", "no results"]`).
    Pass if at least one substring appears, fail with all candidates."""
    needles = case.get("expect_response_contains") or []
    if not needles:
        return []
    haystack = obs.response_text.lower()
    if any(n.lower() in haystack for n in needles):
        return []
    return [f"response missing any of: {needles!r}"]


def _check_response_contains_marker(
    case: dict[str, Any], obs: TurnObservation
) -> list[str]:
    """`blockquote` → markdown `>` style. Anything else is treated as a
    marker kind (must find `[<kind>:` in the response)."""
    target = case.get("expect_response_contains_marker")
    if not target:
        return []
    if target == "blockquote":
        if not has_blockquote(obs.response_text):
            return ["expect blockquote in response but none found"]
        return []
    if not has_marker_kind(obs.response_text, target):
        return [f"expect marker kind={target!r} in response but none found"]
    return []


# Regexes for marker-hygiene predicates. The CLIENT-FACING shape of
# each marker after expansion:
#   audio fragment  — [cite:track_X@s-e]   or [cite:...|caption]
#   verse card      — [verse:source/tok]   or [verse:...|addr_label]
#   whole-track     — [card:track_X]
# The MarkerExpander emits exactly these shapes; anything else is a
# regression.
_CITE_EXPANDED_RE = re.compile(r"\[cite:[^|@\]]+@\d+-\d+(?:\|[^\]]*)?\]")
_VERSE_EXPANDED_RE = re.compile(r"\[verse:[^/|\]]+/[^|\]]+(?:\|[^\]]*)?\]")
_CARD_EXPANDED_RE = re.compile(r"\[card:[^\]\s|@]+\]")
_FOOTNOTE_LEFTOVER_RE = re.compile(r"\[\^\d+\]")
# Pre-[^N] integer-ref shapes — if these leak past the expander
# something is broken in the regex chain.
_LEGACY_INTEGER_REF_RE = re.compile(r"\[(?:ref|cite|verse|card|outline):\d+(?:\|[^\]]*)?\]")


def _check_no_duplicate_markers(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    """If `expect_no_duplicate_markers` is true, fail when any single
    expanded marker (`[cite:...]`, `[verse:...]`, `[card:...]`)
    appears more than once in the response. The LLM should structure
    its reply so each note backs ONE thesis paragraph — repeats
    produce spammy chip stacks in the UI."""
    if not case.get("expect_no_duplicate_markers"):
        return []
    text = obs.response_text
    failures: list[str] = []
    for name, pattern in (
        ("cite", _CITE_EXPANDED_RE),
        ("verse", _VERSE_EXPANDED_RE),
        ("card", _CARD_EXPANDED_RE),
    ):
        counts: dict[str, int] = {}
        for m in pattern.finditer(text):
            counts[m.group(0)] = counts.get(m.group(0), 0) + 1
        dupes = {k: v for k, v in counts.items() if v > 1}
        if dupes:
            top = sorted(dupes.items(), key=lambda kv: -kv[1])[:3]
            sample = ", ".join(f"{m!r}×{c}" for m, c in top)
            failures.append(
                f"expect_no_duplicate_markers: {name} markers repeat — {sample}"
            )
    return failures


def _check_no_unexpanded_footnote(
    case: dict[str, Any], obs: TurnObservation
) -> list[str]:
    """Server-side MarkerExpander must convert every `[^N]` to its
    expanded shape before the response reaches the client. If raw
    `[^N]` leaks through, either the regex broke or there's a code
    path bypassing the expander."""
    if not case.get("expect_no_unexpanded_footnote", True):
        return []
    leftovers = _FOOTNOTE_LEFTOVER_RE.findall(obs.response_text)
    if leftovers:
        return [
            f"raw [^N] markers leaked past expander: {leftovers[:5]!r}"
        ]
    return []


def _check_no_legacy_marker(case: dict[str, Any], obs: TurnObservation) -> list[str]:
    """Pre-migration integer-ref shapes like `[ref:1]`, `[cite:1]`,
    `[verse:2|...]` must never reach the client — they're either an
    LLM hallucination of the old protocol or a regex misfire. The
    MarkerExpander legacy-drop branch should swallow them."""
    if not case.get("expect_no_legacy_marker", True):
        return []
    leftovers = _LEGACY_INTEGER_REF_RE.findall(obs.response_text)
    if leftovers:
        return [
            f"legacy integer-ref markers leaked past expander: {leftovers[:5]!r}"
        ]
    return []


# Ordered list of predicate runners. Each returns failure strings.
_PREDICATES = (
    _check_intent,
    _check_no_tool,
    _check_first_tool,
    _check_first_tool_args,
    _check_first_tool_result,
    _check_tool_chain,
    _check_no_marker_kind,
    _check_response_contains,
    _check_response_contains_marker,
    _check_no_duplicate_markers,
    _check_no_unexpanded_footnote,
    _check_no_legacy_marker,
)


def evaluate_case(
    case: dict[str, Any], obs: TurnObservation
) -> tuple[bool, list[str]]:
    """Run every predicate the case declares against the observation.

    Returns (passed, failures). `passed=True` when no failures were
    collected. Predicates the case doesn't declare are skipped — a case
    with only `expect_intent` won't fail on missing tool checks.
    """
    failures: list[str] = []
    for predicate in _PREDICATES:
        failures.extend(predicate(case, obs))
    return (not failures), failures


# ── Live runner ───────────────────────────────────────────────────────
# The runner below talks to the real chat service. Kept separate from
# pure predicate logic above so the file can be imported (and its
# predicates unit-tested) without spinning up infra.


async def _run_one(
    case: dict[str, Any], chat_client: Any, sem: asyncio.Semaphore
) -> dict[str, Any]:
    """Run one case under the semaphore, return a result dict.

    Failures inside the chat client surface as a `case+error` row; the
    runner doesn't crash on per-case errors so a single network blip
    doesn't kill the whole batch.
    """
    async with sem:
        query = case["query"]
        try:
            obs = await chat_client.observe_turn(
                query,
                context=case.get("context", {}),
                lang=case.get("lang", "ru"),
            )
        except Exception as exc:  # noqa: BLE001 — surface raw error for triage
            return {"case": query, "error": repr(exc), "passed": False}

        passed, failures = evaluate_case(case, obs)
        return {
            "case": query,
            "intent": obs.intent,
            "tool_chain": obs.tool_names,
            "response_chars": len(obs.response_text),
            "response_text": obs.response_text,
            "passed": passed,
            "failures": failures,
        }


async def run_eval(
    cases_path: Path, results_path: Path, *, concurrency: int = 5
) -> int:
    """Execute every case in parallel (bounded by `concurrency`), write
    per-case results to disk, print a summary.

    `concurrency=5` is conservative for OpenRouter — most Gemini Flash
    Lite plans tolerate 10+ concurrent. Bump if you have headroom.

    Returns the process exit code (0 = all OK, 1 = at least one
    regression).
    """
    try:
        from tests.evals._fixtures import make_chat_client  # type: ignore
    except ImportError:
        print(
            "tests/evals/_fixtures.make_chat_client not found.\n"
            "Wire a chat client adapter for your environment (LLM key,\n"
            "test DB) returning TurnObservation, then re-run."
        )
        return 2

    chat_client = make_chat_client()
    cases = load_jsonl(cases_path)
    if not cases:
        print("no cases loaded")
        return 0

    # Warm up the client once (the lazy factory builds DB pool, LLM,
    # graph on the first observe_turn call — we don't want N parallel
    # workers racing on that). A tiny noop turn keeps it cheap.
    print(f"warming up client (1 call)...")
    await chat_client.observe_turn("__warmup__")
    print(f"running {len(cases)} cases with concurrency={concurrency}...")

    sem = asyncio.Semaphore(concurrency)
    tasks = [_run_one(case, chat_client, sem) for case in cases]
    # Run as_completed to print live progress (one dot per case) so the
    # user can see things ARE happening even though we don't pipe through
    # tail anymore.
    results: list[dict[str, Any]] = []
    for done in asyncio.as_completed(tasks):
        r = await done
        results.append(r)
        marker = "." if r.get("passed") else "F"
        print(marker, end="", flush=True)
    print()  # newline after the dots

    # Preserve original case order in results.jsonl so diffs are stable.
    case_order = {c["query"]: i for i, c in enumerate(cases)}
    results.sort(key=lambda r: case_order.get(r["case"], 9999))

    results_path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in results) + "\n"
    )
    pass_count = sum(1 for r in results if r.get("passed"))
    accuracy = pass_count / len(cases)
    print(f"\n{pass_count} / {len(cases)} passed ({accuracy:.0%})")
    for r in results:
        if not r.get("passed"):
            reasons = "; ".join(r.get("failures") or [])
            if not reasons and r.get("error"):
                reasons = f"error: {r['error']}"
            print(f"  FAIL: {r['case']!r} — {reasons}")
    return 0 if accuracy >= 0.90 else 1


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run chunk_tools eval against the live multi-agent graph",
    )
    p.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    p.add_argument("--results", type=Path, default=DEFAULT_RESULTS)
    p.add_argument(
        "--concurrency",
        type=int,
        default=5,
        help="Parallel cases under the OpenRouter call cap (default 5)",
    )
    p.add_argument(
        "--filter",
        "-k",
        default=None,
        help=(
            "Substring match against case['query']. Pass a few chars to "
            "rerun just the cases you're iterating on, skipping the rest."
        ),
    )
    return p.parse_args()


async def _main_with_filter(args: argparse.Namespace) -> int:
    cases = load_jsonl(args.cases)
    results_path = args.results
    if args.filter:
        flt = args.filter.lower()
        filtered_cases = [c for c in cases if flt in c["query"].lower()]
        if not filtered_cases:
            print(f"no cases match filter {args.filter!r}")
            return 2
        print(f"filter {args.filter!r} matched {len(filtered_cases)}/{len(cases)} cases:")
        for c in filtered_cases:
            print(f"  • {c['query']!r}")
        # Filtered runs write to a side file to keep the canonical
        # results.jsonl as the last full-run snapshot.
        results_path = args.results.with_suffix(".filtered.jsonl")
        # Re-write a temp filtered cases file so run_eval (which loads
        # from path) only sees the subset.
        tmp_cases = args.cases.with_suffix(".filtered.tmp.jsonl")
        tmp_cases.write_text(
            "\n".join(json.dumps(c, ensure_ascii=False) for c in filtered_cases) + "\n"
        )
        try:
            return await run_eval(tmp_cases, results_path, concurrency=args.concurrency)
        finally:
            tmp_cases.unlink(missing_ok=True)
    return await run_eval(args.cases, results_path, concurrency=args.concurrency)


if __name__ == "__main__":
    args = _parse_args()
    raise SystemExit(asyncio.run(_main_with_filter(args)))
