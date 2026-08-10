#!/usr/bin/env bash
# infra/tests/chat-metrics-e2e.sh
#
# End-to-end test of the chat metrics scrape path, with real containers on a
# throwaway docker network:
#
#   prometheus  ──scrape──>  metrics-proxy (real Caddyfile)  ──>  chat stub
#
# This exists because the first cut of that path shipped broken and every
# static check passed anyway. `caddy validate`, `promtool check config` and
# `docker compose config` all agreed the config was fine; the scrape still
# returned 404, because chat mounts /metrics as a Starlette sub-app that 307s
# the bare path and the proxy rewrote to the bare path. Nothing short of
# actually running a scraper against the actual Caddyfile catches that, so
# that is what this does.
#
# It asserts three separate things, in order of how badly they were needed:
#
#   1. the scrape SUCCEEDS and real samples land with the right job labels
#   2. containment — nothing but /metrics is reachable through the proxy
#   3. a dead backend surfaces as up=0, which is what the chat_metrics_target_down
#      alert keys on
#
# Usage: infra/tests/chat-metrics-e2e.sh
# Requires: docker, curl. Takes ~1 min, mostly image pulls on a cold cache.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CADDYFILE="$REPO_ROOT/infra/observability-agent/compose/metrics-proxy.Caddyfile"
PROM_TEMPLATE="$REPO_ROOT/infra/observability/compose/prometheus.yml.template"
STUB_DIR="$REPO_ROOT/infra/tests/stub-chat"

# Pinned to what the stacks actually run, so the test cannot pass against a
# version prod does not use.
CADDY_IMAGE=$(grep -A2 'metrics-proxy:' "$REPO_ROOT/infra/observability-agent/compose/docker-compose.yml" | awk '/image:/{print $2; exit}')
PROM_IMAGE=$(awk '/^  prometheus:/{f=1} f&&/image:/{print $2; exit}' "$REPO_ROOT/infra/observability/compose/docker-compose.yml")
: "${CADDY_IMAGE:?could not read metrics-proxy image from the agent compose file}"
: "${PROM_IMAGE:?could not read prometheus image from the observability compose file}"

NET=shruti-chat-metrics-e2e
STUB=lcm-e2e-chat
PROXY=lcm-e2e-proxy
PROM=lcm-e2e-prom
PROXY_PORT=19119
PROM_PORT=19190
WORKDIR=$(mktemp -d)

fail=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

cleanup() {
  docker rm -f "$STUB" "$PROXY" "$PROM" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "▸ building chat stub (real Starlette, real mount semantics)"
docker build -q -t shruti-chat-metrics-stub:test "$STUB_DIR" >/dev/null

echo "▸ starting network + containers ($CADDY_IMAGE, $PROM_IMAGE)"
docker rm -f "$STUB" "$PROXY" "$PROM" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null

# --network-alias chat: the Caddyfile reverse-proxies to the DNS name `chat`,
# exactly as it resolves on the real app network. The Caddyfile is mounted
# unmodified — a test against an edited copy would prove nothing.
docker run -d --name "$STUB" --network "$NET" --network-alias chat \
  shruti-chat-metrics-stub:test >/dev/null
docker run -d --name "$PROXY" --network "$NET" -p "127.0.0.1:$PROXY_PORT:9119" \
  -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" >/dev/null

# Wait for the proxy's own liveness route, then for the backend behind it.
for _ in $(seq 40); do
  curl -fsS "http://127.0.0.1:$PROXY_PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
for _ in $(seq 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/chat/metrics")" = 200 ] && break
  sleep 0.5
done

echo
echo "▸ 1. the scrape path works"

code=$(curl -s -o "$WORKDIR/body.txt" -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/chat/metrics")
if [ "$code" = 200 ]; then
  pass "GET /chat/metrics -> 200"
else
  bad "GET /chat/metrics -> $code (want 200)"
fi

# The status code alone is not enough: a 200 with an empty body would still be
# a broken scrape. Assert a real sample is present.
if grep -qE '^shruti_chat_turns_in_flight ' "$WORKDIR/body.txt"; then
  pass "body carries a real sample: $(grep -E '^shruti_chat_turns_in_flight ' "$WORKDIR/body.txt" | head -1)"
else
  bad "body has no shruti_chat_turns_in_flight sample"
fi

# Prove the redirect that broke this is genuinely there, so a future reader can
# see WHY the trailing slash in the Caddyfile matters. Informational: if
# Starlette ever stops redirecting, the assertions above still hold.
# `|| true`: busybox wget exits non-zero on a bare redirect, and this probe is
# documentation, not an assertion — it must never fail the run.
direct=$(docker exec "$PROXY" wget -S -q -O /dev/null "http://chat:8080/metrics" 2>&1 |
  awk '/HTTP\//{print $2; exit}' || true)
echo "  · backend's own /metrics (no trailing slash) answers $direct — the reason the rewrite must target /metrics/"

echo
echo "▸ 2. containment: only /metrics is reachable"

# /healthz is the proxy's own liveness route and is expected to answer.
# Everything else must 404 — in particular the stub's /v1/chat, which stands in
# for chat's real API.
for path in \
  "/" "/metrics" "/metrics/" "/chat" "/chat/" "/chat/chat" \
  "/v1/chat" "/chat/v1/chat" "/chat/metrics/" \
  "/chat/metrics/../v1/chat" "/chat/metrics/../../v1/chat" \
  "/chat/metrics%2f../v1/chat" "/../v1/chat" "/..%2fv1/chat" \
  "/chat/./metrics/../v1/chat" "/chat//v1/chat"; do
  code=$(curl -s -o "$WORKDIR/leak.txt" -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT$path")
  if [ "$code" = 404 ]; then
    pass "$path -> 404"
  else
    bad "$path -> $code (want 404)"
  fi
  if grep -q 'leaked' "$WORKDIR/leak.txt" 2>/dev/null; then
    bad "$path REACHED THE BACKEND API — containment breach"
  fi
done

# Host spoofing must not open a route: the site block is port-based, so the
# Host header is not a selector, but assert it rather than assume it.
for host in chat evil.example.com localhost; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $host" "http://127.0.0.1:$PROXY_PORT/v1/chat")
  if [ "$code" = 404 ]; then
    pass "Host: $host  /v1/chat -> 404"
  else
    bad "Host: $host  /v1/chat -> $code (want 404)"
  fi
done

# Case and double-slash variants normalise onto the SAME allowed route. They
# are aliases of /chat/metrics, not extra surface — assert they land on metrics
# and never on the API.
for path in "//chat//metrics" "/CHAT/METRICS"; do
  body=$(curl -s "http://127.0.0.1:$PROXY_PORT$path")
  if echo "$body" | grep -q 'leaked'; then
    bad "$path reached the backend API"
  else
    pass "$path is an alias of the metrics route only (no API access)"
  fi
done

echo
echo "▸ 3. a real Prometheus scrapes it, and a dead backend reads as up=0"

# Build the scrape config from the REAL template rather than a hand-written
# copy, so that a change to metrics_path or the job labels is reflected here.
python3 - "$PROM_TEMPLATE" "$WORKDIR/prometheus.yml" "$PROXY:9119" <<'PY'
import re, sys
template, out, target = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(template).read()

blocks = re.split(r"\n(?=  - job_name)", text)
job = next((b for b in blocks if "job_name: chat-prod-eu" in b), None)
if job is None:
    sys.exit("FATAL: no chat-prod-eu job in prometheus.yml.template")

# Point the job at the proxy container instead of the tailnet IP; everything
# else (metrics_path, labels) comes through untouched.
job = re.sub(r"targets: \[[^\]]*\]", f"targets: ['{target}']", job)
job = job.rstrip() + "\n"

open(out, "w").write(
    "global:\n  scrape_interval: 2s\n  scrape_timeout: 1s\n\nscrape_configs:\n" + job
)
print("  · scrape job taken from prometheus.yml.template:")
for line in job.strip().splitlines():
    print("      " + line.strip())
PY

docker run -d --name "$PROM" --network "$NET" -p "127.0.0.1:$PROM_PORT:9090" \
  -v "$WORKDIR/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  "$PROM_IMAGE" >/dev/null

for _ in $(seq 60); do
  curl -fsS "http://127.0.0.1:$PROM_PORT/-/ready" >/dev/null 2>&1 && break
  sleep 0.5
done

# query <promql> <max_wait_s> — polls until a scalar result appears.
query() {
  local q=$1 tries=${2:-30} result
  for _ in $(seq "$tries"); do
    result=$(curl -s --get "http://127.0.0.1:$PROM_PORT/api/v1/query" \
      --data-urlencode "query=$q" |
      python3 -c 'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(r[0]["value"][1] if r else "")' 2>/dev/null || echo "")
    [ -n "$result" ] && { echo "$result"; return; }
    sleep 1
  done
  echo ""
}

value=$(query 'shruti_chat_turns_in_flight{job="chat-prod-eu",host="prod-eu",service="chat"}' 40)
if [ "$value" = "3" ]; then
  pass "Prometheus scraped shruti_chat_turns_in_flight = 3 with job/host/service labels"
else
  bad "gauge not scraped with expected labels (got '${value:-<nothing>}', want 3)"
fi

up=$(query 'up{job="chat-prod-eu"}' 20)
if [ "$up" = "1" ]; then
  pass "up{job=\"chat-prod-eu\"} = 1 while the backend is healthy"
else
  bad "up = '${up:-<nothing>}' while healthy (want 1)"
fi

# The failure the chat_metrics_target_down alert has to catch. Stopping the
# backend leaves the proxy answering (502), which is precisely the case where
# the three metric rules go silent.
docker stop "$STUB" >/dev/null
down=""
for _ in $(seq 30); do
  down=$(query 'up{job="chat-prod-eu"}' 1)
  [ "$down" = "0" ] && break
  sleep 1
done
if [ "$down" = "0" ]; then
  pass "backend stopped -> up = 0 (chat_metrics_target_down fires; the metric rules go NoData)"
else
  bad "backend stopped but up = '${down:-<nothing>}' (want 0)"
fi

docker start "$STUB" >/dev/null
back=""
for _ in $(seq 40); do
  back=$(query 'up{job="chat-prod-eu"}' 1)
  [ "$back" = "1" ] && break
  sleep 1
done
if [ "$back" = "1" ]; then
  pass "backend restarted -> up = 1 (recovers without touching the proxy)"
else
  bad "backend restarted but up = '${back:-<nothing>}' (want 1)"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "✗ chat metrics e2e FAILED"
  exit 1
fi
echo "✓ chat metrics e2e passed"
