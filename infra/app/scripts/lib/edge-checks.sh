# shellcheck shell=bash
# Checks deploy.sh runs for the edge role, in one file so that
# infra/tests/edge-e2e.sh exercises the same code.

# The CDN probe object must be larger than this, so that a connection which
# stalls after its first few KB fails the probe.
EDGE_CDN_PROBE_MIN_BYTES=65536

# edge_cdn_probe_ok <url> [max_seconds] [curl args...]
# Succeeds only when curl read the whole body within max_seconds and the body
# is larger than EDGE_CDN_PROBE_MIN_BYTES. curl exits non-zero on a timeout and
# on a body shorter than its Content-Length, and even then prints the size it
# got, so its exit status is checked before the size is. Prints what it saw.
edge_cdn_probe_ok() {
  local url=$1 max=${2:-30} size rc
  shift 2 || shift $#
  if size=$(curl -fsS "$@" --max-time "$max" -o /dev/null -w '%{size_download}' "$url" 2>/dev/null); then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" != 0 ]; then
    echo "curl exit $rc after $size bytes"
    return 1
  fi
  if ! [[ "$size" =~ ^[0-9]+$ ]] || [ "$size" -le "$EDGE_CDN_PROBE_MIN_BYTES" ]; then
    echo "$size bytes, want more than $EDGE_CDN_PROBE_MIN_BYTES"
    return 1
  fi
  echo "$size bytes"
}

# Services a host may be running when it is switched to edge: an edge's own,
# and the regional share stack (postgres, redis, migrator, share-*) a regional
# host runs until it is converted. Anything else — origin's auth, chat, the
# per-service databases, or a service added later — means the host is not a
# regional host, and switching it would stop that service.
EDGE_SWITCHABLE_SERVICES="caddy watchtower docker-socket-proxy postgres redis migrator share-audio share-video share-transcript"

# edge_switch_blockers <running service...> — prints, one per line, the
# running services that make a switch to edge unsafe.
edge_switch_blockers() {
  local svc
  for svc in "$@"; do
    case " $EDGE_SWITCHABLE_SERVICES " in
      *" $svc "*) ;;
      *) echo "$svc" ;;
    esac
  done
}

# The oldest Compose that honours the !override and !reset tags the edge
# overlay relies on; older ones ignore them silently.
EDGE_MIN_COMPOSE_VERSION=2.24.4

# compose_version_ok <version> — version as `docker compose version --short`
# prints it, with or without a leading "v" and a build suffix.
compose_version_ok() {
  local v=${1#v}
  v=${v%%[-+]*}
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  [ "$(printf '%s\n%s\n' "$EDGE_MIN_COMPOSE_VERSION" "$v" | sort -V | head -1)" = "$EDGE_MIN_COMPOSE_VERSION" ]
}
