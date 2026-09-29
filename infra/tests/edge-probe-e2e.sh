#!/usr/bin/env bash
# infra/tests/edge-probe-e2e.sh
#
# Runs the observability host's blackbox modules against real edges — the
# shruti-caddy image as SHRUTI_REGION_ROLE=edge — between HTTPS stub upstreams:
#
#   blackbox (infra/observability/compose/blackbox.yml)
#     ──TLS──> edge-ok     /healthz/cdn → a 200 000-byte object
#     ──TLS──> edge-short  /healthz/cdn → a 1 000-byte object
#     ──TLS──> edge-stall  /healthz/cdn → 2 000 bytes, then a pause past the
#                                          probe budget, then the rest
#                 └──TLS──> origin.test / cdn.test (stubs)
#     ──TLS──> app-origin  the image as SHRUTI_REGION_ROLE=origin, no apps
#
# It asserts what the alerts read: probe_success per check, the body length the
# CDN size floor keys on, that a stalled transfer fails inside the budget
# instead of hanging, that an origin outage fails only the API leg, that the
# reference module is answered by origin's Caddy with every app down, and the
# mirror-manifest module.
#
# Usage: infra/tests/edge-probe-e2e.sh
# Requires: docker, curl, jq. Linux (the blackbox uses host networking).
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CADDY_DIR="$REPO_ROOT/infra/app/compose/caddy"
STUB_DIR="$REPO_ROOT/infra/tests/stub-upstream"
OBS_COMPOSE="$REPO_ROOT/infra/observability/compose"
BLACKBOX_CONFIG="$OBS_COMPOSE/blackbox.yml"

BLACKBOX_IMAGE=$(awk '/^  blackbox-exporter:/{f=1} f&&/image:/{print $2; exit}' "$OBS_COMPOSE/docker-compose.yml")
: "${BLACKBOX_IMAGE:?no blackbox-exporter service in the observability compose file}"
CADDY_IMAGE=shruti-caddy:edge-probe-e2e
STUB_IMAGE=shruti-stub-upstream:edge-probe-e2e
NET=shruti-edge-probe-e2e
P=shruti-edge-probe-e2e
ORIGIN=$P-origin
CDN=$P-cdn
BLACKBOX=$P-blackbox
BLACKBOX_ADDR=127.0.0.1:${EDGE_PROBE_E2E_BLACKBOX_PORT:-19115}
PORT_OK=${EDGE_PROBE_E2E_PORT:-18453}
PORT_SHORT=$((PORT_OK + 1))
PORT_STALL=$((PORT_OK + 2))
PORT_ORIGIN=$((PORT_OK + 3))
STALL_PAUSE=30
WORKDIR=$(mktemp -d)
chmod 755 "$WORKDIR"

fail=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

remove_containers() {
  docker rm -f "$P-ok" "$P-short" "$P-stall" "$P-app-origin" "$ORIGIN" "$CDN" "$BLACKBOX" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
cleanup() {
  remove_containers
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# probe <module> <target> — the blackbox's metrics for one probe; empty when
# the blackbox does not answer within a minute, which every check reads as a
# failure.
probe() {
  curl -s --max-time 60 -G "http://$BLACKBOX_ADDR/probe" \
    --data-urlencode "module=$1" --data-urlencode "target=$2" || true
}

# metric <name> <metrics text> — the value of an unlabelled gauge.
metric() {
  awk -v n="$1" '$1 == n {print $2; exit}' <<<"$2"
}

echo "▸ building images"
docker build -q -t "$CADDY_IMAGE" "$CADDY_DIR" >/dev/null
docker build -q -t "$STUB_IMAGE" "$STUB_DIR" >/dev/null
pass "images built"

docker run --rm -v "$WORKDIR:/w" --entrypoint sh "$STUB_IMAGE" -c '
  set -e; cd /w
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=edge-probe-e2e-ca \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
    -keyout ca.key -out ca.pem 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj /CN=origin.test -keyout server.key -out server.csr 2>/dev/null
  printf "subjectAltName=DNS:origin.test,DNS:cdn.test\nextendedKeyUsage=serverAuth\n" > ext.cnf
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
    -extfile ext.cnf -out server.pem 2>/dev/null
  chmod 644 /w/*'

remove_containers
docker network create "$NET" >/dev/null
docker run -d --name "$ORIGIN" --network "$NET" --network-alias origin.test \
  -e ROLE=origin -v "$WORKDIR:/certs:ro" "$STUB_IMAGE" >/dev/null
docker run -d --name "$CDN" --network "$NET" --network-alias cdn.test \
  -e ROLE=cdn -e SSE_PAUSE="$STALL_PAUSE" -v "$WORKDIR:/certs:ro" "$STUB_IMAGE" >/dev/null

# start_edge <name> <port> <cdn probe path>
start_edge() {
  docker run -d --name "$P-$1" --network "$NET" -p "127.0.0.1:$2:443" \
    -e SHRUTI_REGION_ROLE=edge -e DOMAIN=localhost -e ACME_EMAIL=ops@example.com \
    -e SHRUTI_GLOBAL_HOST=origin.test \
    -e SHRUTI_EDGE_CDN_UPSTREAM=https://cdn.test \
    -e SHRUTI_EDGE_CDN_PROBE_PATH="$3" \
    -e SHRUTI_HTTP_PROTOCOLS="h1 h2" \
    -e SSL_CERT_FILE=/certs/ca.pem -v "$WORKDIR:/certs:ro" \
    "$CADDY_IMAGE" >/dev/null
}
start_edge ok "$PORT_OK" /public/probe.bin
start_edge short "$PORT_SHORT" /public/range.bin
start_edge stall "$PORT_STALL" /public/stall.bin
# Origin's Caddy with no app containers behind it: what the reference probe
# sees when every origin app is down but origin's host and Caddy are up.
docker run -d --name "$P-app-origin" --network "$NET" -p "127.0.0.1:$PORT_ORIGIN:443" \
  -e SHRUTI_REGION_ROLE=origin -e DOMAIN=localhost -e ACME_EMAIL=ops@example.com \
  -e SHRUTI_GLOBAL_HOST=origin.test \
  "$CADDY_IMAGE" >/dev/null

# Each edge issues its site certificate from its own internal CA; the blackbox
# trusts those roots and nothing else, so every probe verifies a real chain.
: >"$WORKDIR/roots.pem"
for e in ok short stall app-origin; do
  for _ in $(seq 60); do
    docker exec "$P-$e" test -s /data/caddy/pki/authorities/local/root.crt 2>/dev/null && break
    sleep 0.5
  done
  docker exec "$P-$e" cat /data/caddy/pki/authorities/local/root.crt >>"$WORKDIR/roots.pem"
done
chmod 644 "$WORKDIR/roots.pem"
for port in "$PORT_OK" "$PORT_SHORT" "$PORT_STALL" "$PORT_ORIGIN"; do
  for _ in $(seq 60); do
    [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 -X OPTIONS "https://localhost:$port/healthz" 2>/dev/null)" != 000 ] && break
    sleep 0.5
  done
done

docker run -d --name "$BLACKBOX" --network host \
  -e SSL_CERT_FILE=/roots/roots.pem -v "$WORKDIR:/roots:ro" \
  -v "$BLACKBOX_CONFIG:/etc/blackbox_exporter/config.yml:ro" \
  "$BLACKBOX_IMAGE" --config.file=/etc/blackbox_exporter/config.yml \
  --web.listen-address="$BLACKBOX_ADDR" >/dev/null
for _ in $(seq 60); do
  curl -sf -o /dev/null "http://$BLACKBOX_ADDR/-/healthy" && break
  sleep 0.5
done

echo
echo "▸ a healthy edge: every check passes"
for path in /healthz /healthz/api /healthz/cdn; do
  out=$(probe http_edge "https://localhost:$PORT_OK$path")
  if [ "$(metric probe_success "$out")" = 1 ]; then
    pass "$path probe_success 1"
  else
    bad "$path probe_success $(metric probe_success "$out") (want 1)"
    grep -E '^probe_(http_status_code|failed_due_to)' <<<"$out" | sed 's/^/      /'
  fi
done
out=$(probe http_edge "https://localhost:$PORT_OK/healthz/cdn")
len=$(metric probe_http_uncompressed_body_length "$out")
if [ "${len:-0}" -ge 65536 ]; then
  pass "/healthz/cdn body length $len (≥ 65536, the alert floor)"
else
  bad "/healthz/cdn body length ${len:-missing} (want ≥ 65536)"
fi

echo
echo "▸ a short CDN object: the probe reports the length the floor keys on"
out=$(probe http_edge "https://localhost:$PORT_SHORT/healthz/cdn")
len=$(metric probe_http_uncompressed_body_length "$out")
if [ -n "$len" ] && [ "$len" -lt 65536 ]; then
  pass "/healthz/cdn body length $len (< 65536: edge_node_cdn_leg_failing fires)"
else
  bad "/healthz/cdn body length ${len:-missing} (want < 65536)"
fi

echo
echo "▸ a CDN leg that stalls: the probe fails inside its budget"
start=$(date +%s)
out=$(probe http_edge "https://localhost:$PORT_STALL/healthz/cdn")
took=$(($(date +%s) - start))
if [ "$(metric probe_success "$out")" = 0 ] && [ "$took" -lt "$STALL_PAUSE" ]; then
  pass "probe_success 0 after ${took}s (stall ${STALL_PAUSE}s)"
else
  bad "probe_success $(metric probe_success "$out") after ${took}s (want 0, well before ${STALL_PAUSE}s)"
fi

echo
echo "▸ origin down: only the API leg fails"
docker stop "$ORIGIN" >/dev/null
declare -A want=([/healthz]=1 [/healthz/api]=0 [/healthz/cdn]=1)
for path in /healthz /healthz/api /healthz/cdn; do
  got=$(metric probe_success "$(probe http_edge "https://localhost:$PORT_OK$path")")
  if [ "$got" = "${want[$path]}" ]; then
    pass "$path probe_success $got"
  else
    bad "$path probe_success $got (want ${want[$path]})"
  fi
done

echo
echo "▸ reference module: origin's Caddy, not an app behind it"
got=$(metric probe_success "$(probe http_reference "https://localhost:$PORT_ORIGIN/healthz")")
if [ "$got" = 1 ]; then
  pass "origin with every app down still answers the reference probe"
else
  bad "reference probe with origin apps down: probe_success $got (want 1)"
fi
got=$(metric probe_success "$(probe http_edge "https://localhost:$PORT_ORIGIN/healthz")")
if [ "$got" = 0 ]; then
  pass "the same origin fails a GET /healthz, which an app answers"
else
  bad "GET /healthz with origin apps down: probe_success $got (want 0)"
fi

echo
echo "▸ mirror manifest module"
got=$(metric probe_success "$(probe http_mirror_config "https://localhost:$PORT_OK/public/config.json")")
if [ "$got" = 1 ]; then
  pass "a JSON object body passes"
else
  bad "a JSON object body: probe_success $got (want 1)"
fi
got=$(metric probe_success "$(probe http_mirror_config "https://localhost:$PORT_OK/public/range.bin")")
if [ "$got" = 0 ]; then
  pass "a 200 whose body is not a JSON object fails"
else
  bad "a non-JSON 200: probe_success $got (want 0)"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "✗ edge probe e2e FAILED"
  exit 1
fi
echo "✓ edge probe e2e passed"
