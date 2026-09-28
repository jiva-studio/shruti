"""Checks over the provisioned Grafana alert rules.

Three jobs:

1. Extract every PromQL expression into a real Prometheus rules file, so
   `promtool check rules` can parse them for real. Grafana will happily
   provision a rule whose expression does not parse — it just never fires.

2. Assert the properties that decide whether a broken scrape is visible. With
   `noDataState: OK` on every chat rule, a dead scrape target renders as green
   alerts — the precise failure the group exists to detect.

3. Optionally write every rule of the plain shape — one Prometheus query and a
   threshold on it — as a Prometheus alerting rule (`(<query>) <op> <value>`,
   same `for` and labels), so `promtool test rules` can drive it with synthetic
   series. Grafana thresholds that shape per series as Prometheus does, with
   one difference promtool cannot show: a series that drops out of the result
   is kept pending or firing by Grafana for two more evaluations before it is
   resolved, where Prometheus resets it at once. Rules that must not flap on a
   series gap read a window (`avg_over_time`) rather than the last sample.

Usage: check_alert_rules.py <rules.yml> <out-rules.yml> [<out-alerting.yml>]
"""

import re
import sys

import yaml

CHAT_GROUP = "chat"
CANARY = "chat_metrics_target_down"
CANARY_EXPR = 'up{job="chat-prod-eu"}'

EDGE_GROUP = "edge-nodes"
EDGE_CANARY = "probe_scrape_failing"
EDGE_PROBE_JOBS = ("blackbox-edge-nodes", "blackbox-mirror", "blackbox-reference")
EDGE_JOB = 'job="blackbox-edge-nodes"'
EDGE_LEGS = ('check="api"', 'check="cdn"')
EDGE_GATE = re.compile(r'\band on ?\(edge\) \(.*check="healthz".*\) >= ')
_REFERENCE = r'max\([^()]*\(probe_success\{job="blackbox-reference"\}\[\w+\]\)\) < [0-9.]+'
_ALL_EDGES_DOWN = (
    r'max\(min by \(edge\) \([^()]*\(probe_success\{job="blackbox-edge-nodes",'
    r'check="healthz"\}\[\w+\]\)\)\) < [0-9.]+'
)
EDGE_REFERENCE_ONLY = re.compile(rf"\bunless on ?\(\) \({_REFERENCE}\)$")
EDGE_OBSERVER_DOWN = re.compile(
    rf"\bunless on ?\(\) \(\({_REFERENCE}\) and on ?\(\) \({_ALL_EDGES_DOWN}\)\)$"
)

THRESHOLD_OPS = {"gt": ">", "lt": "<"}


def rule_exprs(rule: dict) -> str:
    return " ".join(
        node.get("model", {}).get("expr", "") for node in rule.get("data", [])
    )


def as_prometheus_alert(rule: dict) -> dict | None:
    """The rule as a Prometheus alerting rule, or None when it is not exactly
    one Prometheus query with one threshold on it."""
    queries = {
        node["refId"]: node["model"]["expr"]
        for node in rule.get("data", [])
        if node.get("datasourceUid") == "prometheus"
        and node.get("model", {}).get("expr")
    }
    cond = next(
        (n for n in rule.get("data", []) if n.get("refId") == rule.get("condition")),
        None,
    )
    if cond is None or len(queries) != 1:
        return None
    model = cond.get("model", {})
    conditions = model.get("conditions") or []
    if (
        model.get("type") != "threshold"
        or model.get("expression") not in queries
        or len(conditions) != 1
    ):
        return None
    evaluator = conditions[0].get("evaluator", {})
    op = THRESHOLD_OPS.get(evaluator.get("type"))
    params = evaluator.get("params") or []
    if op is None or len(params) != 1:
        return None
    alert = {
        "alert": rule["uid"],
        "expr": f"({queries[model['expression']]}) {op} {params[0]}",
        "labels": dict(rule.get("labels") or {}),
    }
    if rule.get("for"):
        alert["for"] = rule["for"]
    return alert


def chat_problems(chat_rules: dict[str, dict]) -> list[str]:
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
    elif CANARY_EXPR not in rule_exprs(chat_rules[CANARY]):
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
    return problems


def edge_problems(edge_rules: dict[str, dict]) -> list[str]:
    if not edge_rules:
        return [f"no {EDGE_GROUP} group: the edge and mirror probes page nobody"]
    problems: list[str] = []

    # --- the probe path itself must be watched -----------------------------
    # Every other rule here is noDataState OK, so a dead blackbox would read as
    # every edge healthy.
    canary = edge_rules.get(EDGE_CANARY)
    if canary is None:
        problems.append(
            f"no {EDGE_CANARY} rule: with the blackbox down every edge rule "
            "goes NoData, which this group reads as healthy"
        )
    else:
        joined = rule_exprs(canary)
        if "up{" not in joined or not all(job in joined for job in EDGE_PROBE_JOBS):
            problems.append(
                f"{EDGE_CANARY} must key on up{{}} of {', '.join(EDGE_PROBE_JOBS)}"
            )

    for uid, rule in sorted(edge_rules.items()):
        # --- zero edges is a valid config, not an outage --------------------
        if rule.get("noDataState") != "OK":
            problems.append(
                f"{uid}: noDataState is {rule.get('noDataState')!r}; must be 'OK' "
                "— with no edges configured there are no series, and "
                f"{EDGE_CANARY} covers a dead probe path"
            )
        # --- one broken edge pages once ------------------------------------
        joined = rule_exprs(rule)
        if any(leg in joined for leg in EDGE_LEGS) and not EDGE_GATE.search(joined):
            problems.append(
                f"{uid}: an upstream-leg alert must be gated with `and on (edge)` "
                'on the edge\'s own check="healthz" ratio, or a down edge pages '
                "once per leg"
            )
        # --- the observer's own outage is not every edge's outage ----------
        if EDGE_JOB not in joined:
            continue
        expr = joined.strip()
        if 'check="api"' in expr:
            if not EDGE_REFERENCE_ONLY.search(expr):
                problems.append(
                    f"{uid}: an API-leg alert must end with `unless on () "
                    "(<reference ratio> < N)` — it fails whenever origin is "
                    "unreachable, which the reference alert reports"
                )
        elif not EDGE_OBSERVER_DOWN.search(expr):
            problems.append(
                f"{uid}: an edge alert must end with `unless on () ((<reference "
                "ratio> < N) and on () (max(min by (edge) (<healthz ratio>)) < N))` "
                "— held off only when the reference and every edge fail together, "
                "so an origin outage never masks a dead edge"
            )
    return problems


def main() -> int:
    src, out = sys.argv[1], sys.argv[2]
    alerting_out = sys.argv[3] if len(sys.argv) > 3 else None
    doc = yaml.safe_load(open(src))

    exprs: list[tuple[str, str]] = []
    groups: dict[str, dict[str, dict]] = {}
    alerts: list[dict] = []
    total = 0

    for group in doc.get("groups", []):
        for rule in group.get("rules", []):
            total += 1
            uid = rule.get("uid", "<no uid>")
            for node in rule.get("data", []):
                expr = node.get("model", {}).get("expr")
                if expr:
                    exprs.append((uid, expr))
            groups.setdefault(group.get("name"), {})[uid] = rule
            alert = as_prometheus_alert(rule)
            if alert is not None:
                alerts.append(alert)

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

    if alerting_out:
        with open(alerting_out, "w") as fh:
            yaml.safe_dump(
                {"groups": [{"name": "grafana", "rules": alerts}]},
                fh,
                default_flow_style=False,
                sort_keys=False,
            )

    print(
        f"  · {total} rules, {len(exprs)} expressions extracted, "
        f"{len(alerts)} as alerting rules"
    )

    chat_rules = groups.get(CHAT_GROUP, {})
    edge_rules = groups.get(EDGE_GROUP, {})
    problems = chat_problems(chat_rules) + edge_problems(edge_rules)

    if problems:
        for problem in problems:
            print(f"PROBLEM {problem}")
        return 1

    print(
        f"  · alert-state guards OK ({len(chat_rules)} chat rules, "
        f"{len(edge_rules)} edge rules)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
