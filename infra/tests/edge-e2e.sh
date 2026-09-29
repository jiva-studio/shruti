#!/usr/bin/env bash
# infra/tests/edge-e2e.sh
#
# Boots the shruti-caddy image as SHRUTI_REGION_ROLE=edge on a throwaway docker
# network, between two HTTPS stub upstreams that record what reaches them:
#
#   curl ──TLS──> edge (the real image, the real Caddyfile)
#                  ├── /public/*  ──TLS──> cdn.test     (stub, ROLE=cdn)
#                  └── the rest   ──TLS──> origin.test  (stub, ROLE=origin)
#
# The stubs present certificates from a CA minted for the run; the edge trusts
# only that CA (SSL_CERT_FILE), so a forwarded request that reaches a stub has
# passed real certificate verification against the upstream's name.
#
# Also checked, without the network: `caddy validate` for every role, and that
# the edge compose overlay resolves to Caddy alone.
#
# Usage: infra/tests/edge-e2e.sh
# Requires: docker (with compose), curl, jq. A cold run spends most of its time
# building the Caddy image.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CADDY_DIR="$REPO_ROOT/infra/app/compose/caddy"
COMPOSE_DIR="$REPO_ROOT/infra/app/compose"
STUB_DIR="$REPO_ROOT/infra/tests/stub-upstream"

CADDY_IMAGE=shruti-caddy:edge-e2e
STUB_IMAGE=shruti-stub-upstream:edge-e2e
# Names carry the run's PID and the edges take free ports, so two runs on one
# docker host do not tear down each other's containers.
RUN=shruti-edge-e2e-$$
NET=$RUN
EDGE=$RUN-edge
ORIGIN=$RUN-origin
CDN=$RUN-cdn
STALL_EDGE=$RUN-edge-stall
ORIGIN_CADDY=$RUN-origin-caddy
ORIGIN_CHAT=$RUN-origin-chat
PRUNE_PROJECT=$RUN-prune
EDGE_PORT=${EDGE_E2E_PORT:-}
WORKDIR=$(mktemp -d)
chmod 755 "$WORKDIR"

# shellcheck source=../app/scripts/lib/edge-checks.sh
source "$REPO_ROOT/infra/app/scripts/lib/edge-checks.sh"

fail=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

remove_prune_fixtures() {
  docker ps -aq --filter "label=com.docker.compose.project=$PRUNE_PROJECT" | xargs -r docker rm -f >/dev/null 2>&1 || true
}

cleanup() {
  docker rm -f "$EDGE" "$STALL_EDGE" "$ORIGIN_CADDY" "$ORIGIN_CHAT" "$ORIGIN" "$CDN" >/dev/null 2>&1 || true
  remove_prune_fixtures
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# edge_curl <curl args...> — every request goes to the published edge port with
# SNI and Host "localhost", which is the site the edge serves in this test.
edge_curl() {
  curl -sk --resolve "localhost:$EDGE_PORT:127.0.0.1" --max-time 15 "$@"
}

# last_request <container> <path> — the most recent recorded request for path.
last_request() {
  { docker exec "$1" cat /tmp/requests.jsonl 2>/dev/null || true; } |
    jq -c --arg p "$2" 'select(.path == $p)' | tail -1
}

echo "▸ building images"
docker build -q -t "$CADDY_IMAGE" "$CADDY_DIR" >/dev/null
docker build -q -t "$STUB_IMAGE" "$STUB_DIR" >/dev/null
pass "caddy image built (the Dockerfile validates every role snippet)"

echo
echo "▸ caddy validate, per role"
for role in origin proxy edge; do
  if docker run --rm \
    -e DOMAIN=validate.invalid -e ACME_EMAIL=validate@invalid \
    -e SHRUTI_REGION_ROLE="$role" -e SHRUTI_GLOBAL_HOST=global.invalid \
    -e SHRUTI_EDGE_CDN_UPSTREAM=https://cdn.invalid -e SHRUTI_EDGE_CDN_PROBE_PATH=/public/probe.bin \
    --entrypoint caddy "$CADDY_IMAGE" validate --adapter caddyfile --config /etc/caddy/Caddyfile \
    >"$WORKDIR/validate-$role.log" 2>&1; then
    pass "role $role"
  else
    bad "role $role"; tail -5 "$WORKDIR/validate-$role.log" | sed 's/^/      /'
  fi
done

echo
echo "▸ compose: an edge host runs Caddy and nothing else"
# edge_compose <args...> — compose over the edge file set with only the
# variables an edge host's .env carries: no database password, no JWT paths.
edge_compose() {
  (cd "$COMPOSE_DIR" && env -i PATH="$PATH" HOME="$HOME" \
    COMPOSE_PROFILES=edge SHRUTI_DOMAIN=edge.example.com SHRUTI_ACME_EMAIL=ops@example.com \
    SHRUTI_GLOBAL_HOST=origin.example.com SHRUTI_EDGE_CDN_UPSTREAM=https://cdn.example.com \
    SHRUTI_EDGE_CDN_PROBE_PATH=/public/probe.bin \
    docker compose -f docker-compose.prod.yml -f docker-compose.edge.yml "$@")
}
services=$(edge_compose config --services 2>"$WORKDIR/compose.err" || true)
if [ "$services" = caddy ]; then
  pass "services: caddy (no postgres password needed)"
else
  bad "services: $(echo "$services" | tr '\n' ' ') (want only caddy)"; sed 's/^/      /' "$WORKDIR/compose.err"
fi
edge_compose config --format json >"$WORKDIR/compose.json" 2>/dev/null || echo '{}' >"$WORKDIR/compose.json"
ports=$(jq -c '[.services.caddy.ports[]? | "\(.published)/\(.protocol)"] | sort' "$WORKDIR/compose.json")
if [ "$ports" = '["443/tcp","80/tcp"]' ]; then
  pass "published ports: $ports (no UDP)"
else
  bad "published ports: $ports (want 80/tcp and 443/tcp only)"
fi
caddy_env=$(jq -r '.services.caddy.environment // {} | "\(.SHRUTI_REGION_ROLE)|\(.SHRUTI_HTTP_PROTOCOLS)"' "$WORKDIR/compose.json")
if [ "$caddy_env" = "edge|h1 h2" ]; then
  pass "caddy runs role edge with protocols h1 h2"
else
  bad "caddy role|protocols = $caddy_env (want edge|h1 h2)"
fi

echo
echo "▸ starting stubs and the edge"
docker run --rm -v "$WORKDIR:/w" --entrypoint sh "$STUB_IMAGE" -c '
  set -e; cd /w
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=edge-e2e-ca \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
    -keyout ca.key -out ca.pem 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj /CN=origin.test -keyout server.key -out server.csr 2>/dev/null
  printf "subjectAltName=DNS:origin.test,DNS:cdn.test\nextendedKeyUsage=serverAuth\n" > ext.cnf
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 \
    -extfile ext.cnf -out server.pem 2>/dev/null
  chmod 644 /w/*'

docker rm -f "$EDGE" "$STALL_EDGE" "$ORIGIN" "$CDN" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
docker run -d --name "$ORIGIN" --network "$NET" --network-alias origin.test \
  -e ROLE=origin -v "$WORKDIR:/certs:ro" "$STUB_IMAGE" >/dev/null
docker run -d --name "$CDN" --network "$NET" --network-alias cdn.test \
  -e ROLE=cdn -v "$WORKDIR:/certs:ro" "$STUB_IMAGE" >/dev/null
# start_edge <container> <port> <cdn probe path>
# DOMAIN=localhost makes Caddy issue the site certificate from its internal CA,
# so the test needs no ACME. SSL_CERT_FILE replaces the system roots for the
# edge's upstream connections with the CA minted above.
start_edge() {
  docker run -d --name "$1" --network "$NET" -p "127.0.0.1:${2:-}:443" \
    -e SHRUTI_REGION_ROLE=edge -e DOMAIN=localhost -e ACME_EMAIL=ops@example.com \
    -e SHRUTI_GLOBAL_HOST=origin.test \
    -e SHRUTI_EDGE_CDN_UPSTREAM=https://cdn.test \
    -e SHRUTI_EDGE_CDN_PROBE_PATH="$3" \
    -e SHRUTI_HTTP_PROTOCOLS="h1 h2" \
    -e SSL_CERT_FILE=/certs/ca.pem -v "$WORKDIR:/certs:ro" \
    "$CADDY_IMAGE" >/dev/null
  local port
  port=$(docker port "$1" 443/tcp | head -1)
  port=${port##*:}
  for _ in $(seq 60); do
    [ "$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' "https://localhost:$port/healthz" 2>/dev/null)" = 200 ] && break
    sleep 0.5
  done
  echo "$port"
}
EDGE_PORT=$(start_edge "$EDGE" "$EDGE_PORT" /public/probe.bin)
BASE="https://localhost:$EDGE_PORT"
# A second edge whose CDN probe object stalls after 16 KB of 200 KB.
STALL_PORT=$(start_edge "$STALL_EDGE" "" /public/stall-long.bin)

echo
echo "▸ health"
body=$(edge_curl "$BASE/healthz" || true)
if [ "$body" = "ok edge" ]; then
  pass "/healthz answered by the edge itself: \"$body\""
else
  bad "/healthz -> \"$body\" (want \"ok edge\")"; docker logs "$EDGE" 2>&1 | tail -20 | sed 's/^/      /'
fi
code=$(edge_curl -o "$WORKDIR/api.json" -w '%{http_code}' "$BASE/healthz/api" || true)
req=$(last_request "$ORIGIN" /healthz)
if [ "$code" = 200 ] && [ -n "$req" ]; then
  pass "/healthz/api -> origin /healthz ($code)"
else
  bad "/healthz/api -> $code, origin saw: ${req:-nothing}"
fi
size=$(edge_curl -o "$WORKDIR/probe.bin" -w '%{http_code} %{size_download}' "$BASE/healthz/cdn" || true)
req=$(last_request "$CDN" /public/probe.bin)
if [ "$size" = "200 200000" ] && [ -n "$req" ]; then
  pass "/healthz/cdn -> CDN probe object, 200000 bytes delivered in full"
else
  bad "/healthz/cdn -> \"$size\" (want \"200 200000\"), CDN saw: ${req:-nothing}"
fi
if edge_cdn_probe_ok "$BASE/healthz/cdn" 10 -k >/dev/null; then
  pass "deploy.sh's CDN probe check passes on the healthy edge"
else
  bad "deploy.sh's CDN probe check fails on the healthy edge"
fi
if edge_cdn_probe_ok "https://localhost:$STALL_PORT/healthz/cdn" 5 -k >/dev/null; then
  bad "deploy.sh's CDN probe check passes although the CDN stalls after 16 KB"
else
  pass "deploy.sh's CDN probe check fails when the CDN stalls after 16 KB"
fi
if edge_cdn_probe_ok "$BASE/public/stall-unsized.bin" 5 -k >/dev/null; then
  bad "deploy.sh's CDN probe check passes a body of unknown length that stalls after 100 KB"
else
  pass "deploy.sh's CDN probe check fails a body of unknown length that stalls after 100 KB"
fi
if edge_cdn_probe_ok "$BASE/public/range.bin" 10 -k >/dev/null; then
  bad "deploy.sh's CDN probe check passes a complete 1000-byte object"
else
  pass "deploy.sh's CDN probe check fails a complete object no larger than 64 KB"
fi

echo
echo "▸ deploy.sh's Compose version gate"
for case in "2.24.3:no" "2.24.4:yes" "v2.30.1:yes" "2.3.3:no" "1.29.2:no" "5.2.0:yes" "2.24.4-desktop.1:yes" ":no" "garbage:no"; do
  v=${case%%:*} want=${case##*:}
  if compose_version_ok "$v"; then got=yes; else got=no; fi
  if [ "$got" = "$want" ]; then
    pass "Compose \"$v\" accepted: $got"
  else
    bad "Compose \"$v\" accepted: $got (want $want)"
  fi
done

echo
echo "▸ switching a host to edge removes the services edge does not run"
remove_prune_fixtures
for svc in caddy watchtower docker-socket-proxy postgres; do
  docker run -d --name "$PRUNE_PROJECT-$svc" \
    --label "com.docker.compose.project=$PRUNE_PROJECT" --label "com.docker.compose.service=$svc" \
    --entrypoint sleep "$STUB_IMAGE" 300 >/dev/null
done
(cd "$COMPOSE_DIR" && env -i PATH="$PATH" HOME="$HOME" COMPOSE_PROJECT_NAME="$PRUNE_PROJECT" \
  COMPOSE_PROFILES=edge SHRUTI_DOMAIN=edge.example.com SHRUTI_ACME_EMAIL=ops@example.com \
  SHRUTI_GLOBAL_HOST=origin.example.com SHRUTI_EDGE_CDN_UPSTREAM=https://cdn.example.com \
  SHRUTI_EDGE_CDN_PROBE_PATH=/public/probe.bin \
  bash ../scripts/remove-inactive-services.sh -f docker-compose.prod.yml -f docker-compose.edge.yml) \
  >"$WORKDIR/prune.log" 2>&1 || true
left=$(docker ps -a --filter "label=com.docker.compose.project=$PRUNE_PROJECT" \
  --format '{{.Label "com.docker.compose.service"}}' | sort | tr '\n' ' ')
if [ "$left" = "caddy " ]; then
  pass "only caddy is left of caddy, watchtower, docker-socket-proxy, postgres"
else
  bad "left running: ${left:-nothing} (want caddy only)"; sed 's/^/      /' "$WORKDIR/prune.log"
fi
remove_prune_fixtures

# A file set with a service that has no profile: without COMPOSE_PROFILES that
# service alone is active, so an unguarded cleanup would remove caddy.
cat >"$WORKDIR/unprofiled.yml" <<'YML'
services:
  caddy:
    image: busybox
    profiles: [edge]
  watchtower:
    image: busybox
YML
# refusal_case <label> <profiles> <compose file args...>
refusal_case() {
  local label=$1 profiles=$2 refused left svc
  shift 2
  for svc in caddy watchtower; do
    docker run -d --name "$PRUNE_PROJECT-$svc" \
      --label "com.docker.compose.project=$PRUNE_PROJECT" --label "com.docker.compose.service=$svc" \
      --entrypoint sleep "$STUB_IMAGE" 300 >/dev/null
  done
  if (cd "$COMPOSE_DIR" && env -i PATH="$PATH" HOME="$HOME" COMPOSE_PROJECT_NAME="$PRUNE_PROJECT" \
    ${profiles:+COMPOSE_PROFILES="$profiles"} \
    SHRUTI_DOMAIN=edge.example.com SHRUTI_ACME_EMAIL=ops@example.com \
    SHRUTI_GLOBAL_HOST=origin.example.com SHRUTI_EDGE_CDN_UPSTREAM=https://cdn.example.com \
    SHRUTI_EDGE_CDN_PROBE_PATH=/public/probe.bin \
    bash ../scripts/remove-inactive-services.sh "$@") >"$WORKDIR/prune-refuse.log" 2>&1; then
    refused=no
  else
    refused=yes
  fi
  left=$(docker ps -a --filter "label=com.docker.compose.project=$PRUNE_PROJECT" \
    --format '{{.Label "com.docker.compose.service"}}' | sort | tr '\n' ' ')
  if [ "$refused" = yes ] && [ "$left" = "caddy watchtower " ]; then
    pass "$label: the cleanup refuses and removes nothing"
  else
    bad "$label: refused=$refused, left: ${left:-nothing} (want refused, caddy and watchtower kept)"
    sed 's/^/      /' "$WORKDIR/prune-refuse.log"
  fi
  remove_prune_fixtures
}
refusal_case "without COMPOSE_PROFILES" "" -f "$WORKDIR/unprofiled.yml"
refusal_case "with a profile no service has" nosuchrole -f docker-compose.prod.yml -f docker-compose.edge.yml

echo
echo "▸ deploy.sh refuses to turn a host running origin services into an edge"
for case in \
  "caddy watchtower docker-socket-proxy postgres redis migrator share-audio share-video share-transcript|" \
  "|" \
  "caddy|" \
  "caddy postgres auth chat redis|auth chat" \
  "caddy storage-sync|storage-sync" \
  "caddy some-future-service|some-future-service"; do
  running=${case%%|*} want=${case##*|}
  # shellcheck disable=SC2086
  got=$(edge_switch_blockers $running 2>/dev/null | tr '\n' ' ' | sed 's/ $//' || true)
  if [ "$got" = "$want" ]; then
    pass "running [${running:-nothing}] blocks: [${got:-nothing}]"
  else
    bad "running [${running:-nothing}] blocks: [${got:-nothing}] (want [${want:-nothing}])"
  fi
done

echo
echo "▸ /public/* goes to the CDN"
edge_curl -o /dev/null "$BASE/public/catalog/item.json" || true
req=$(last_request "$CDN" /public/catalog/item.json)
host=$(jq -r '.headers.host // empty' <<<"${req:-{\}}")
sni=$(jq -r '.sni // empty' <<<"${req:-{\}}")
if [ "$host" = cdn.test ] && [ "$sni" = cdn.test ]; then
  pass "CDN saw Host=$host SNI=$sni"
else
  bad "CDN saw Host=${host:-?} SNI=${sni:-?} (want cdn.test for both)"
fi
if [ -z "$(last_request "$ORIGIN" /public/catalog/item.json)" ]; then
  pass "origin never saw it"
else
  bad "/public/* reached origin"
fi

for path in /public/catalog/private.json /healthz/cdn; do
  edge_curl -o /dev/null -H 'Authorization: Bearer user-token' -H 'Cookie: session=secret' -H 'X-Real-IP: 198.51.100.12' "$BASE$path" || true
done
leaked=$({ docker exec "$CDN" cat /tmp/requests.jsonl 2>/dev/null || true; } |
  jq -r 'select(.headers.authorization != null or .headers.cookie != null or .headers["x-real-ip"] != null) | .path' | sort -u | tr '\n' ' ')
seen=$(last_request "$CDN" /public/catalog/private.json)
if [ -n "$seen" ] && [ -z "$leaked" ]; then
  pass "client Authorization, Cookie and X-Real-IP never reach the CDN"
else
  bad "CDN received client credentials on: ${leaked:-?} (request seen: ${seen:+yes})"
fi

out=$(edge_curl -D "$WORKDIR/range.h" -H 'Range: bytes=100-199' -o "$WORKDIR/range.bin" \
  -w '%{http_code} %{size_download}' "$BASE/public/range.bin" || true)
want=$(printf '0123456789%.0s' $(seq 10))
crange=$(awk -F': ' 'tolower($1)=="content-range"{print $2}' "$WORKDIR/range.h" | tr -d '\r')
if [ "$out" = "206 100" ] && [ "$(cat "$WORKDIR/range.bin")" = "$want" ] && [ "$crange" = "bytes 100-199/1000" ]; then
  pass "Range bytes=100-199 -> 206, the right 100 bytes, Content-Range $crange"
else
  bad "Range -> \"$out\", Content-Range \"$crange\" (want \"206 100\", bytes 100-199/1000)"
fi

echo
echo "▸ everything else goes to origin"
edge_curl -o /dev/null -X POST -H 'Authorization: Bearer test-token' \
  -H 'Content-Type: application/json' -H 'X-Forwarded-For: 198.51.100.7' \
  -H 'X-Real-IP: 198.51.100.8' -H 'Forwarded: for=198.51.100.9' \
  -H 'True-Client-IP: 198.51.100.10' -H 'CF-Connecting-IP: 198.51.100.11' \
  -H 'X-Client-IP: 198.51.100.13' -H 'Client-IP: 198.51.100.14' -H 'X-Cluster-Client-IP: 198.51.100.15' \
  -H 'Fastly-Client-IP: 198.51.100.16' -H 'X-Original-Forwarded-For: 198.51.100.17' \
  --data '{"question":"hello"}' "$BASE/chat" || true
req=$(last_request "$ORIGIN" /chat)
if [ -n "$req" ]; then
  checks=$(jq -r '[
      (.method == "POST"),
      (.body == "{\"question\":\"hello\"}"),
      (.headers.authorization == "Bearer test-token"),
      (.headers.host == "origin.test"),
      (.sni == "origin.test"),
      ((.headers["x-forwarded-host"] // "") | startswith("localhost")),
      ((.headers["x-forwarded-for"] // "") != ""),
      ((.headers["x-forwarded-for"] // "") | contains("198.51.100.7") | not),
      ([.headers["x-real-ip", "forwarded", "true-client-ip", "cf-connecting-ip", "x-client-ip", "client-ip", "x-cluster-client-ip", "fastly-client-ip", "x-original-forwarded-for"]] | all(. == null))
    ] | map(tostring) | join(" ")' <<<"$req")
  if [ "$checks" = "true true true true true true true true true" ]; then
    pass "POST /chat: method, body, Authorization intact; Host/SNI origin.test; X-Forwarded-Host set; client-sent X-Forwarded-For replaced; other client-IP headers dropped"
  else
    bad "POST /chat reached origin but checks were [$checks]: $req"
  fi
else
  bad "POST /chat never reached origin"
fi

edge_curl -o /dev/null -X POST --data '{}' "$BASE/share/audio/excerpts" || true
if [ -n "$(last_request "$ORIGIN" /share/audio/excerpts)" ]; then
  pass "/share/audio/excerpts forwarded to origin with its full path"
else
  bad "/share/audio/excerpts did not reach origin"
fi

for path in /auth/signin/google /profile/sync/pull /webhooks/revenuecat /discovery/search /some/new/route; do
  edge_curl -o /dev/null "$BASE$path" || true
  if [ -n "$(last_request "$ORIGIN" "$path")" ]; then
    pass "$path -> origin"
  else
    bad "$path did not reach origin"
  fi
done

echo
echo "▸ responses stream, they are not buffered"
start=$(date +%s%N)
stamps=$(edge_curl -N "$BASE/chat/sse" | while IFS= read -r line; do
  case "$line" in data:*) echo "$(( ($(date +%s%N) - start) / 1000000 ))" ;; esac
done || true)
first=$(sed -n 1p <<<"$stamps")
second=$(sed -n 2p <<<"$stamps")
if [ -n "$first" ] && [ -n "$second" ] && [ "$first" -lt 2000 ] && [ "$second" -ge 2500 ]; then
  pass "first event after ${first}ms, second after ${second}ms (upstream pauses 3s between them)"
else
  bad "event arrival times: first=${first:-none}ms second=${second:-none}ms (want first < 2000, second >= 2500)"
fi

# The stamp is taken when the first 1000 bytes are in, not when the pipeline
# ends: curl itself only exits after the stall, on its next write.
start=$(date +%s%N)
read -r got elapsed < <(edge_curl -N "$BASE/public/stall.bin" | {
  n=$(head -c 1000 | wc -c)
  echo "$n $(( ($(date +%s%N) - start) / 1000000 ))"
  cat >/dev/null
} || true)
if [ "$got" = 1000 ] && [ "$elapsed" -lt 2000 ]; then
  pass "/public body streamed: first 1000 bytes after ${elapsed}ms while the upstream stalls 3s"
else
  bad "/public body: $got bytes after ${elapsed}ms (want 1000 bytes before the upstream's 3s stall ends)"
fi

echo
echo "▸ origin: health probes are not rate-limited"
# The same image as role origin, with a plain HTTP server standing in for the
# chat service it forwards /healthz, /readyz and /chat to: a request that passes
# the rate limit gets that server's answer, and a 429 means the limit fired.
docker run -d --name "$ORIGIN_CHAT" --network "$NET" --network-alias chat \
  --entrypoint python "$STUB_IMAGE" -m http.server 8080 >/dev/null
docker run -d --name "$ORIGIN_CADDY" --network "$NET" -p "127.0.0.1::443" \
  -e SHRUTI_REGION_ROLE=origin -e DOMAIN=localhost -e ACME_EMAIL=ops@example.com \
  -e SHRUTI_GLOBAL_HOST=global.invalid "$CADDY_IMAGE" >/dev/null
origin_port=$(docker port "$ORIGIN_CADDY" 443/tcp | head -1)
origin_port=${origin_port##*:}
for _ in $(seq 60); do
  [ "$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' "https://localhost:$origin_port/readyz" 2>/dev/null)" != 000 ] && break
  sleep 0.5
done
# 1001 probes of each path: each alone is past the 1000/h budget of the zone
# that covers the root paths.
codes=$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}\n' \
  "https://localhost:$origin_port/healthz?probe=[1-1001]" \
  -o /dev/null "https://localhost:$origin_port/readyz?probe=[1-1001]" | sort | uniq -c | tr -s ' ' | tr '\n' ',' || true)
if [ -n "$codes" ] && ! grep -q ' 429,' <<<"$codes"; then
  pass "1001 /healthz and 1001 /readyz probes on origin: none limited ($codes)"
else
  bad "probes on origin were rate-limited: ${codes:-no answer}"
fi
code=$(curl -sk --max-time 10 -o /dev/null -w '%{http_code}' -X POST "https://localhost:$origin_port/chat" || true)
if [ "$code" != 429 ] && [ "$code" != 000 ]; then
  pass "a /chat request after the probes is not limited ($code): probes do not use the chat budget"
else
  bad "/chat after the probes answered $code (probes used the chat budget)"
fi

echo
echo "▸ HTTP/3 is not advertised"
leaked=0
for path in /healthz /healthz/api /public/catalog/item.json /chat; do
  code=$(edge_curl -o /dev/null -D "$WORKDIR/alt.h" -w '%{http_code}' "$BASE$path" || true)
  alt=$(awk -F': ' 'tolower($1)=="alt-svc"{print $2}' "$WORKDIR/alt.h" 2>/dev/null | tr -d '\r')
  if [ "$code" != 200 ]; then
    bad "$path -> $code, cannot judge its headers"; leaked=1
  elif [ -n "$alt" ]; then
    bad "$path carries Alt-Svc: $alt"; leaked=1
  fi
done
if [ "$leaked" = 0 ]; then
  pass "no Alt-Svc on edge responses, although both upstreams send one"
fi

echo
if [ "$fail" = 0 ]; then
  echo "✓ edge e2e passed"
else
  echo "✗ edge e2e FAILED"
fi
exit "$fail"
