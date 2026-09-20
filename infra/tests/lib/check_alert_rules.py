"""Checks over the provisioned Grafana alert rules.

Two jobs:

1. Extract every PromQL expression into a real Prometheus rules file, so
   `promtool check rules` can parse them for real. Grafana will happily
   provision a rule whose expression does not parse — it just never fires.

2. Assert the properties that decide whether a broken scrape is VISIBLE. This
   is the regression guard for the review of PR #1591: the chat group shipped
   with `noDataState: OK` on every rule, so a dead scrape target rendered as
   three green alerts — the precise failure the group was written to detect.

Usage: check_alert_rules.py <rules.yml> <out-rules.yml>
"""

import sys

import yaml

CHAT_GROUP = "chat"
CANARY = "chat_metrics_target_down"
CANARY_EXPR = 'up{job="chat-prod-eu"}'


def main() -> int:
    src, out = sys.argv[1], sys.argv[2]
    doc = yaml.safe_load(open(src))

    exprs: list[tuple[str, str]] = []
    chat_rules: dict[str, dict] = {}
    total = 0

    for group in doc.get("groups", []):
        for rule in group.get("rules", []):
            total += 1
            uid = rule.get("uid", "<no uid>")
            for node in rule.get("data", []):
                expr = node.get("model", {}).get("expr")
                if expr:
                    exprs.append((uid, expr))
            if group.get("name") == CHAT_GROUP:
                chat_rules[uid] = rule

    # yaml.safe_dump, not f-string interpolation: several expressions contain
    # regex escapes (`\\.`), and Python's repr mangles them into something
    # promtool rejects with a parse error on an unrelated rule.
    extracted = {
        "groups": [
            {
                "name": "extracted",
                "rules": [{"alert": uid, "expr": expr} for uid, expr in exprs],
            }
        ]
    }
    with open(out, "w") as fh:
        yaml.safe_dump(extracted, fh, default_flow_style=False, sort_keys=False)

    print(f"  · {total} rules, {len(exprs)} expressions extracted")

    problems: list[str] = []

    # --- a dead scrape must not read as green ------------------------------
    for uid, rule in sorted(chat_rules.items()):
        if uid == CANARY:
            for field in ("noDataState", "execErrState"):
                if rule.get(field) != "Alerting":
                    problems.append(
                        f"{uid}: {field} is {rule.get(field)!r}; must be 'Alerting' "
                        "— this rule is the canary for the whole group"
                    )
        elif rule.get("noDataState") == "OK":
            problems.append(
                f"{uid}: noDataState 'OK' means a dead scrape reads as green; "
                "use 'NoData'"
            )

    # --- something must watch the scrape itself ----------------------------
    if CANARY not in chat_rules:
        problems.append(
            f"no {CANARY} rule: every chat alert reads a chat metric, so all of "
            "them go quiet together when the scrape breaks, and quiet is "
            "indistinguishable from healthy"
        )
    else:
        joined = " ".join(
            node.get("model", {}).get("expr", "")
            for node in chat_rules[CANARY].get("data", [])
        )
        if CANARY_EXPR not in joined:
            problems.append(f"{CANARY} must key on {CANARY_EXPR}")

    # --- a single blip must not page ---------------------------------------
    # A counter is monotonic, so rate(...) stays above zero for the whole
    # lookback window after one increment: `> 0` with `for: 5m` is a guaranteed
    # page on a single retryable error.
    for uid, rule in sorted(chat_rules.items()):
        counter_refs = {
            node["refId"]
            for node in rule.get("data", [])
            if "rate(" in node.get("model", {}).get("expr", "")
            and "_total" in node.get("model", {}).get("expr", "")
        }
        for node in rule.get("data", []):
            model = node.get("model", {})
            if model.get("expression") not in counter_refs:
                continue
            for cond in model.get("conditions") or []:
                evaluator = cond.get("evaluator", {})
                params = evaluator.get("params") or [None]
                if evaluator.get("type") == "gt" and params[0] == 0:
                    problems.append(
                        f"{uid}: rate() on a counter against a '> 0' threshold "
                        "pages on a single blip; use increase() with a tolerance"
                    )

    if problems:
        for problem in problems:
            print(f"PROBLEM {problem}")
        return 1

    print(f"  · alert-state guards OK ({len(chat_rules)} chat rules)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
