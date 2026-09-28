#!/usr/bin/env bash
# infra/observability/scripts/lib/render-probe-targets.sh
#
# Writes the file_sd target lists the blackbox-edge-nodes and blackbox-mirror
# Prometheus jobs read:
#
#   <dir>/edges.json   three targets per host in SHRUTI_EDGE_HOSTS
#                      (host[:port], separated by commas and/or whitespace,
#                      newlines included; lowercased, repeats dropped),
#                      labelled edge=<host> and check=healthz|api|cdn
#   <dir>/mirror.json  SHRUTI_MIRROR_CONFIG_URL (an https URL), labelled
#                      check=mirror_config
#
# Both variables are optional; unset or empty renders [].
# shellcheck shell=bash

# Character sets are spelled out: a bracket range such as a-z follows the
# locale's collation and admits accented letters under a UTF-8 locale.

DNS_LABEL_RE='^[abcdefghijklmnopqrstuvwxyz0123456789]([abcdefghijklmnopqrstuvwxyz0123456789-]{0,61}[abcdefghijklmnopqrstuvwxyz0123456789])?$'
PORT_RE='^[123456789][0123456789]{0,4}$'
MIRROR_URL_RE='^https://[^[:space:]"\\]+$'
EDGE_CHECKS=("/healthz healthz" "/healthz/api api" "/healthz/cdn cdn")

# valid_edge_host <host[:port]> — DNS labels of 1–63 characters, none empty,
# 253 characters at most; port 1–65535.
valid_edge_host() {
  local name="${1%%:*}" port label labels=()
  if [[ "$1" == *:* ]]; then
    port="${1#*:}"
    [[ "$port" =~ $PORT_RE ]] && [ "$port" -le 65535 ] || return 1
  fi
  [ -n "$name" ] && [ "${#name}" -le 253 ] || return 1
  [[ "$name" != .* && "$name" != *. ]] || return 1
  IFS=. read -r -a labels <<<"$name"
  for label in "${labels[@]}"; do
    [[ "$label" =~ $DNS_LABEL_RE ]] || return 1
  done
}

# render_probe_targets <dir>
render_probe_targets() {
  local dir="$1" host url check path sep="" entries=() hosts=()
  read -r -d '' -a entries < <(printf '%s' "${SHRUTI_EDGE_HOSTS:-}" | tr ',' ' ' | tr '[:upper:]' '[:lower:]') || true
  for host in "${entries[@]}"; do
    valid_edge_host "$host" || {
      echo "✗ SHRUTI_EDGE_HOSTS: '$host' is not host[:port]" >&2; return 1;
    }
    case " ${hosts[*]} " in
      *" $host "*) ;;
      *) hosts+=("$host") ;;
    esac
  done
  url="${SHRUTI_MIRROR_CONFIG_URL:-}"
  if [ -n "$url" ] && ! [[ "$url" =~ $MIRROR_URL_RE ]]; then
    echo "✗ SHRUTI_MIRROR_CONFIG_URL: '$url' is not an https URL" >&2; return 1
  fi

  mkdir -p "$dir"
  {
    printf '['
    for host in "${hosts[@]}"; do
      for check in "${EDGE_CHECKS[@]}"; do
        path="${check% *}"
        printf '%s\n  {"targets": ["https://%s%s"], "labels": {"edge": "%s", "check": "%s"}}' \
          "$sep" "$host" "$path" "$host" "${check#* }"
        sep=","
      done
    done
    [ -z "$sep" ] || printf '\n'
    printf ']\n'
  } >"$dir/edges.json"

  if [ -n "$url" ]; then
    printf '[\n  {"targets": ["%s"], "labels": {"check": "mirror_config"}}\n]\n' "$url" >"$dir/mirror.json"
  else
    printf '[]\n' >"$dir/mirror.json"
  fi
  local mirror=off
  [ -z "$url" ] || mirror=on
  echo "  · rendered probe targets: ${#hosts[@]} edge(s), mirror probe $mirror"
}
