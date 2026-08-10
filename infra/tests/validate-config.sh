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
    python3 "$CHECKER" "$RULES_YML" "$WORKDIR/rules-extracted.yml"
  else
    docker run --rm \
      -v "$CHECKER:/check.py:ro" -v "$RULES_YML:/rules.yml:ro" -v "$WORKDIR:/w" \
      python:3.12-alpine \
      sh -c 'pip install -q pyyaml && python /check.py /rules.yml /w/rules-extracted.yml'
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
# Render the template the way deploy.sh does, with placeholder values.
export REGION=eu LECTORIUM_DOMAIN=example.test OBS_TS_IP=100.64.0.1 PROD_HOST_TS_IP=100.64.0.2
if command -v envsubst >/dev/null 2>&1; then
  envsubst <"$OBS/compose/prometheus.yml.template" >"$WORKDIR/prometheus.yml"
else
  python3 -c '
import os, re, sys
text = open(sys.argv[1]).read()
open(sys.argv[2], "w").write(re.sub(r"\$\{(\w+)\}", lambda m: os.environ.get(m.group(1), m.group(0)), text))
' "$OBS/compose/prometheus.yml.template" "$WORKDIR/prometheus.yml"
fi

if docker run --rm -v "$WORKDIR:/w:ro" --entrypoint promtool "$PROM_IMAGE" \
  check config /w/prometheus.yml >"$WORKDIR/promtool.log" 2>&1; then
  pass "promtool check config"
else
  bad "promtool check config"; sed 's/^/      /' "$WORKDIR/promtool.log"
fi

if grep -q 'job_name: chat-prod-eu' "$WORKDIR/prometheus.yml" &&
  grep -q 'metrics_path: /chat/metrics' "$WORKDIR/prometheus.yml"; then
  pass "chat-prod-eu job present with metrics_path /chat/metrics"
else
  bad "chat-prod-eu job missing or metrics_path changed"
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
need = ["lectorium-metrics-proxy", "metrics-proxy.Caddyfile", "100.64.0.2", "9119"]
missing = [n for n in need if n not in text]
sys.exit("missing from rendered compose: " + ", ".join(missing) if missing else 0)
'; then
  pass "metrics-proxy renders: tailnet-bound :9119, Caddyfile mounted"
else
  bad "metrics-proxy service did not render as expected"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "✗ observability config validation FAILED"
  exit 1
fi
echo "✓ observability config validation passed"
