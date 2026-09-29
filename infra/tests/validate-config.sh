#!/usr/bin/env bash
# infra/tests/validate-config.sh
#
# Static checks over the observability config: Caddyfile, Prometheus scrape
# config, Grafana alert rules, and the agent compose file. Fast, no networking
# between containers — run it on every PR that touches infra/observability*.
#
# These checks are necessary and NOT sufficient. All of them passed against a
# metrics proxy that returned 404 to every scrape, which is why
# chat-metrics-e2e.sh exists alongside. Keep both.
#
# Usage: infra/tests/validate-config.sh
# Requires: docker, python3 (+ pyyaml).
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OBS="$REPO_ROOT/infra/observability"
AGENT="$REPO_ROOT/infra/observability-agent"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
# promtool runs as nobody inside the image; mktemp -d is 0700, so without this
# every check fails with "permission denied" rather than a real verdict.
chmod 755 "$WORKDIR"

# The rule guards need PyYAML. Prefer the host interpreter; fall back to a
# throwaway container so the script still works on a machine without it.
RULES_YML="$OBS/compose/grafana/provisioning/alerting/rules.yml"
CHECKER="$REPO_ROOT/infra/tests/lib/check_alert_rules.py"
check_alert_rules() {
  if python3 -c 'import yaml' >/dev/null 2>&1; then
    python3 "$CHECKER" "$RULES_YML" "$WORKDIR/rules-extracted.yml" "$WORKDIR/rules-alerting.yml"
  else
    docker run --rm \
      -v "$CHECKER:/check.py:ro" -v "$RULES_YML:/rules.yml:ro" -v "$WORKDIR:/w" \
      python:3.12-alpine \
      sh -c 'pip install -q pyyaml && python /check.py /rules.yml /w/rules-extracted.yml /w/rules-alerting.yml'
  fi
}

CADDY_IMAGE=$(grep -A2 'metrics-proxy:' "$AGENT/compose/docker-compose.yml" | awk '/image:/{print $2; exit}')
PROM_IMAGE=$(awk '/^  prometheus:/{f=1} f&&/image:/{print $2; exit}' "$OBS/compose/docker-compose.yml")

fail=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

echo "▸ Caddyfile (metrics-proxy)"
if docker run --rm -v "$AGENT/compose/metrics-proxy.Caddyfile:/etc/caddy/Caddyfile:ro" \
  --entrypoint caddy "$CADDY_IMAGE" validate --config /etc/caddy/Caddyfile >"$WORKDIR/caddy.log" 2>&1; then
  pass "caddy validate"
else
  bad "caddy validate"; sed 's/^/      /' "$WORKDIR/caddy.log"
fi

# `caddy fmt --diff` echoes the whole file whether or not it changed anything,
# so compare its formatted output against the file instead of testing for empty
# output.
docker run --rm -v "$AGENT/compose/metrics-proxy.Caddyfile:/etc/caddy/Caddyfile:ro" \
  --entrypoint caddy "$CADDY_IMAGE" fmt /etc/caddy/Caddyfile >"$WORKDIR/fmt.out" 2>/dev/null || true
if diff -q "$AGENT/compose/metrics-proxy.Caddyfile" "$WORKDIR/fmt.out" >/dev/null 2>&1; then
  pass "caddy fmt clean"
else
  bad "caddy fmt would reformat the file"
  diff -u "$AGENT/compose/metrics-proxy.Caddyfile" "$WORKDIR/fmt.out" | sed 's/^/      /' | head -20
fi

# The bug that shipped: rewriting to the bare mount path. chat serves /metrics
# from app.mount(), whose Mount 307s /metrics -> /metrics/, so a bare rewrite
# sends the scraper back through the front door onto a path that 404s. Guard
# the fix here as well as in the e2e test, because this one runs in seconds and
# names the reason.
if grep -qE '^\s*rewrite \* /metrics/\s*$' "$AGENT/compose/metrics-proxy.Caddyfile"; then
  pass "rewrite targets /metrics/ (trailing slash — Starlette Mount would 307 otherwise)"
else
  bad "rewrite must target /metrics/ with a trailing slash; see chat main.py app.mount()"
fi

echo
echo "▸ Prometheus scrape config"
# Render the template and the probe target files the way deploy.sh does, with
# placeholder values, into a directory laid out like /etc/prometheus in the
# container, so promtool reads the file_sd files the config names.
export REGION=eu SHRUTI_DOMAIN=example.test OBS_TS_IP=100.64.0.1 PROD_HOST_TS_IP=100.64.0.2
# shellcheck source=../observability/scripts/lib/render-probe-targets.sh
source "$OBS/scripts/lib/render-probe-targets.sh"

render_prometheus() {
  local dir="$1"
  mkdir -p "$dir"
  if command -v envsubst >/dev/null 2>&1; then
    envsubst <"$OBS/compose/prometheus.yml.template" >"$dir/prometheus.yml"
  else
    python3 -c '
import os, re, sys
text = open(sys.argv[1]).read()
open(sys.argv[2], "w").write(re.sub(r"\$\{(\w+)\}", lambda m: os.environ.get(m.group(1), m.group(0)), text))
' "$OBS/compose/prometheus.yml.template" "$dir/prometheus.yml"
  fi
  render_probe_targets "$dir/probe-targets"
}

# promtool_config <dir> <label> — check config with the target files in place.
# A file_sd path that matches no file is only a WARNING to promtool, which
# would let a wrong mount path pass; treat it as a failure.
promtool_config() {
  local dir="$1" label="$2"
  chmod -R a+rX "$dir"
  if docker run --rm -v "$dir:/etc/prometheus:ro" --entrypoint promtool "$PROM_IMAGE" \
    check config /etc/prometheus/prometheus.yml >"$dir.log" 2>&1 &&
    ! grep -qi warning "$dir.log"; then
    pass "promtool check config ($label)"
  else
    bad "promtool check config ($label)"; sed 's/^/      /' "$dir.log"
  fi
}

SHRUTI_EDGE_HOSTS='' SHRUTI_MIRROR_CONFIG_URL='' render_prometheus "$WORKDIR/prom-0"
promtool_config "$WORKDIR/prom-0" "no edges, no mirror"
cp "$WORKDIR/prom-0/prometheus.yml" "$WORKDIR/prometheus.yml"

if grep -q 'job_name: chat-prod-eu' "$WORKDIR/prometheus.yml" &&
  grep -q 'metrics_path: /chat/metrics' "$WORKDIR/prometheus.yml"; then
  pass "chat-prod-eu job present with metrics_path /chat/metrics"
else
  bad "chat-prod-eu job missing or metrics_path changed"
fi

echo
echo "▸ edge and mirror probe targets"
targets0=$(cat "$WORKDIR/prom-0/probe-targets/edges.json" "$WORKDIR/prom-0/probe-targets/mirror.json" 2>/dev/null | tr -d ' \n')
if [ "$targets0" = '[][]' ]; then
  pass "no edges and no mirror URL render empty target lists"
else
  bad "empty env rendered targets: $targets0 (want [] and [])"
fi

# check_targets <dir> <mirror url or ""> <edge host>... — the rendered lists
# hold exactly three checks per given host, labelled edge and check, and the
# given mirror URL (or none).
check_targets() {
  python3 - "$@" <<'PY'
import json, sys
d, mirror_url, hosts = sys.argv[1], sys.argv[2], sys.argv[3:]
edges = json.load(open(f"{d}/edges.json"))
mirror = json.load(open(f"{d}/mirror.json"))
got = sorted((t, g["labels"]["edge"], g["labels"]["check"]) for g in edges for t in g["targets"])
want = sorted(
    (f"https://{h}{p}", h, c)
    for h in hosts
    for p, c in (("/healthz", "healthz"), ("/healthz/api", "api"), ("/healthz/cdn", "cdn"))
)
problems = []
if got != want:
    problems.append(f"edges: {got} != {want}")
m = [(t, g["labels"].get("check")) for g in mirror for t in g["targets"]]
if m != ([(mirror_url, "mirror_config")] if mirror_url else []):
    problems.append(f"mirror: {m}")
for p in problems:
    print("PROBLEM", p)
sys.exit(1 if problems else 0)
PY
}

SHRUTI_EDGE_HOSTS='edge-a.example.test, edge-b.example.test:8443' \
  SHRUTI_MIRROR_CONFIG_URL='https://mirror.example.test/public/config.json' \
  render_prometheus "$WORKDIR/prom-2"
promtool_config "$WORKDIR/prom-2" "two edges and a mirror"

if check_targets "$WORKDIR/prom-2/probe-targets" https://mirror.example.test/public/config.json \
  edge-a.example.test edge-b.example.test:8443; then
  pass "two edges render three checks each, labelled edge and check; the mirror renders one target"
else
  bad "rendered probe targets are wrong (see PROBLEM lines above)"
fi

# Unset variables render empty lists under `set -u`, the way deploy.sh runs.
if (set -u; unset SHRUTI_EDGE_HOSTS SHRUTI_MIRROR_CONFIG_URL; render_probe_targets "$WORKDIR/unset") \
  >/dev/null 2>"$WORKDIR/unset.err" && [ ! -s "$WORKDIR/unset.err" ] &&
  check_targets "$WORKDIR/unset" ""; then
  pass "unset SHRUTI_EDGE_HOSTS and SHRUTI_MIRROR_CONFIG_URL render empty lists under set -u"
else
  bad "unset SHRUTI_EDGE_HOSTS / SHRUTI_MIRROR_CONFIG_URL fail the render"
fi

# One edge per line, mixed case, repeats, tabs: every host kept once, lowercased.
if (SHRUTI_EDGE_HOSTS=$'Edge-A.Example.TEST\nedge-a.example.test, EDGE-B.example.test:8443\n\tedge-b.example.test:8443 edge-c.example.test,,' \
  SHRUTI_MIRROR_CONFIG_URL='' render_probe_targets "$WORKDIR/norm") >/dev/null 2>&1 &&
  check_targets "$WORKDIR/norm" "" edge-a.example.test edge-b.example.test:8443 edge-c.example.test; then
  pass "newlines, case variants and repeats render each edge once, lowercased"
else
  bad "edge list normalisation (see PROBLEM lines above)"
fi

for job in blackbox-edge-nodes blackbox-mirror blackbox-reference; do
  if grep -q "job_name: $job" "$WORKDIR/prometheus.yml"; then
    pass "$job job present"
  else
    bad "$job job missing"
  fi
done

for hosts in 'https://edge.example.test' 'edge.example.test/healthz' 'edge".example.test' 'edge example..test/x' \
  'edge..example.test' '.edge.example.test' 'edge.example.test.' '-edge.example.test' 'edge-.example.test' \
  'edge.example.test:0' 'edge.example.test:65536' 'edge.example.test:99999' 'edge.example.test:' \
  "$(printf 'a%.0s' $(seq 64)).example.test"; do
  if (SHRUTI_EDGE_HOSTS="$hosts" SHRUTI_MIRROR_CONFIG_URL='' render_probe_targets "$WORKDIR/reject") 2>/dev/null; then
    bad "renderer accepted edge entry '$hosts'"
  else
    pass "renderer refuses edge entry '$hosts'"
  fi
done
# Hosts are matched byte by byte: a UTF-8 locale whose collation sorts
# accented letters inside a-z must not let them through.
if locale -a 2>/dev/null | grep -qiE '^en_US\.utf-?8$'; then
  for hosts in 'édge.example.test' 'straße.example.test'; do
    if (LC_ALL=en_US.UTF-8; SHRUTI_EDGE_HOSTS="$hosts" SHRUTI_MIRROR_CONFIG_URL='' render_probe_targets "$WORKDIR/reject") 2>/dev/null; then
      bad "renderer accepted edge entry '$hosts' under en_US.UTF-8"
    else
      pass "renderer refuses edge entry '$hosts' under en_US.UTF-8"
    fi
  done
else
  bad "no en_US.UTF-8 locale here to check byte-wise host matching"
fi

# The reference job probes origin with the module Caddy answers itself.
if python3 - "$WORKDIR/prometheus.yml" <<'PY'; then
import sys, yaml
jobs = {j["job_name"]: j for j in yaml.safe_load(open(sys.argv[1]))["scrape_configs"]}
ref = jobs["blackbox-reference"]
targets = [t for s in ref["static_configs"] for t in s["targets"]]
ok = ref["params"]["module"] == ["http_reference"] and targets == ["https://example.test/healthz"]
sys.exit(0 if ok else f"blackbox-reference: module {ref['params']['module']}, targets {targets}")
PY
  pass "blackbox-reference probes origin's /healthz with http_reference"
else
  bad "blackbox-reference job does not use http_reference on origin's /healthz"
fi

for url in 'mirror.example.test/config.json' 'https://mirror.example.test/a b' 'https://mirror.example.test/"x'; do
  if (SHRUTI_EDGE_HOSTS='' SHRUTI_MIRROR_CONFIG_URL="$url" render_probe_targets "$WORKDIR/reject") 2>/dev/null; then
    bad "renderer accepted mirror URL '$url'"
  else
    pass "renderer refuses mirror URL '$url'"
  fi
done

echo
echo "▸ blackbox modules (observability host)"
BLACKBOX_IMAGE=$(awk '/^  blackbox-exporter:/{f=1} f&&/image:/{print $2; exit}' "$OBS/compose/docker-compose.yml")
if [ -n "$BLACKBOX_IMAGE" ] && docker run --rm -v "$OBS/compose/blackbox.yml:/config.yml:ro" "$BLACKBOX_IMAGE" \
  --config.file=/config.yml --config.check >"$WORKDIR/blackbox.log" 2>&1; then
  pass "blackbox_exporter --config.check ($BLACKBOX_IMAGE)"
else
  bad "blackbox_exporter --config.check (image: ${BLACKBOX_IMAGE:-none in compose})"; sed 's/^/      /' "$WORKDIR/blackbox.log" 2>/dev/null || true
fi

echo
echo "▸ Grafana alert rules"
# Extract every PromQL expression into a real Prometheus rules file so promtool
# parses them for real, and assert the properties that decide whether a broken
# scrape is visible at all. See infra/tests/lib/check_alert_rules.py.
rc=0
check_alert_rules || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "alert rules: no-data states and canary rule are sane"
else
  bad "alert rule guards failed (see PROBLEM lines above)"
fi

if docker run --rm -v "$WORKDIR:/w:ro" --entrypoint promtool "$PROM_IMAGE" \
  check rules /w/rules-extracted.yml >"$WORKDIR/rules.log" 2>&1; then
  pass "promtool check rules (all extracted PromQL parses)"
else
  bad "promtool check rules"; sed 's/^/      /' "$WORKDIR/rules.log"
fi

# The single-query threshold rules, as Prometheus alerting rules, driven by
# the synthetic series in infra/tests/alerts/.
mkdir -p "$WORKDIR/alerts"
cp "$REPO_ROOT"/infra/tests/alerts/*.test.yml "$WORKDIR/alerts/"
if [ -s "$WORKDIR/rules-alerting.yml" ]; then
  cp "$WORKDIR/rules-alerting.yml" "$WORKDIR/alerts/"
fi
chmod -R a+rX "$WORKDIR/alerts"
if (cd "$WORKDIR/alerts" && docker run --rm -v "$WORKDIR/alerts:/t:ro" -w /t --entrypoint promtool "$PROM_IMAGE" \
  test rules ./*.test.yml) >"$WORKDIR/rule-tests.log" 2>&1; then
  rule_tests=("$WORKDIR"/alerts/*.test.yml)
  pass "promtool test rules (${#rule_tests[@]} files)"
else
  bad "promtool test rules"; sed 's/^/      /' "$WORKDIR/rule-tests.log"
fi

echo
echo "▸ Grafana dashboards"
if python3 - "$OBS/compose/grafana/provisioning/dashboards/json" <<'PY'; then
import glob, json, sys
uids = {}
problems = []
for path in sorted(glob.glob(f"{sys.argv[1]}/*.json")):
    try:
        dash = json.load(open(path))
    except ValueError as e:
        problems.append(f"{path}: {e}")
        continue
    uid = dash.get("uid")
    if uid and uid in uids:
        problems.append(f"{path}: uid {uid} also in {uids[uid]}")
    uids[uid] = path
for p in problems:
    print("PROBLEM", p)
sys.exit(1 if problems else 0)
PY
  pass "dashboard JSON parses, uids unique"
else
  bad "dashboard JSON (see PROBLEM lines above)"
fi

echo
echo "▸ compose"
# Placeholders for the deploy-time values; `config` only has to interpolate and
# type-check the file, and the real secrets live on the hosts.
compose_env=(
  PROD_EU_TS_IP=100.64.0.2
  OBS_TS_IP=100.64.0.1
  PG_EXPORTER_PASSWORD=placeholder
  ORCHESTRATOR_PG_EXPORTER_PASSWORD=placeholder
)
if (cd "$AGENT/compose" && env "${compose_env[@]}" \
  docker compose --env-file /dev/null config >"$WORKDIR/compose-agent.log" 2>&1); then
  pass "docker compose config (observability-agent)"
else
  bad "docker compose config (observability-agent)"
  sed 's/^/      /' "$WORKDIR/compose-agent.log"
fi

# The metrics-proxy service is the new surface; assert the parts that the
# scrape and the containment story depend on actually render.
if (cd "$AGENT/compose" && env "${compose_env[@]}" docker compose --env-file /dev/null config 2>/dev/null) |
  python3 -c '
import sys
text = sys.stdin.read()
need = ["shruti-metrics-proxy", "metrics-proxy.Caddyfile", "100.64.0.2", "9119"]
missing = [n for n in need if n not in text]
sys.exit("missing from rendered compose: " + ", ".join(missing) if missing else 0)
'; then
  pass "metrics-proxy renders: tailnet-bound :9119, Caddyfile mounted"
else
  bad "metrics-proxy service did not render as expected"
fi

# The observability side: the probe jobs address blackbox-exporter:9115 and
# read /etc/prometheus/probe-targets; both have to exist in the stack.
if (cd "$OBS/compose" && OBS_TS_IP=100.64.0.1 docker compose --env-file /dev/null config --format json 2>/dev/null) |
  python3 -c '
import json, sys
svc = json.load(sys.stdin)["services"]
def mounts(name):
    return {v["target"]: v.get("source", "") for v in svc.get(name, {}).get("volumes", [])}
problems = []
if "blackbox-exporter" not in svc:
    problems.append("no blackbox-exporter service")
elif not mounts("blackbox-exporter").get("/etc/blackbox_exporter/config.yml", "").endswith("/blackbox.yml"):
    problems.append("blackbox-exporter does not mount blackbox.yml")
if not mounts("prometheus").get("/etc/prometheus/probe-targets", "").endswith("/probe-targets"):
    problems.append("prometheus does not mount probe-targets at /etc/prometheus/probe-targets")
sys.exit("; ".join(problems) if problems else 0)
'; then
  pass "observability compose: blackbox-exporter with blackbox.yml, probe targets mounted into prometheus"
else
  bad "observability compose does not wire the probe jobs"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "✗ observability config validation FAILED"
  exit 1
fi
echo "✓ observability config validation passed"
