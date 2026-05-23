#!/usr/bin/env bash
# infra/observability/scripts/lib/bootstrap-cloudflare-dns.sh
#
# Creates / updates the wildcard A record
#   *.obs.${REGION}.shruti.akdasa.studio → ${OBS_TS_IP}
# in Cloudflare via the v4 API. The record is `proxied: false` (Cloudflare
# DNS only) because the Tailscale IP isn't routable from Cloudflare edge.
#
# Required env (set by configure.sh):
#   CF_API_TOKEN, CF_ZONE_ID, REGION, TAILNET_DOMAIN, OBS_TS_IP
#
# Idempotent: if the record exists with the same content, it's a no-op; if
# the IP changed, it's PATCHed.
# shellcheck shell=bash

bootstrap_cloudflare_dns() {
  require_vars CF_API_TOKEN CF_ZONE_ID TAILNET_DOMAIN OBS_TS_IP || return 1
  local name="*.${TAILNET_DOMAIN}"
  log "Cloudflare DNS: ensuring $name → $OBS_TS_IP"

  local existing
  existing=$(curl -fsS \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?type=A&name=${name}" \
    | jq -r '.result[0] // empty')

  local payload
  payload=$(jq -nc --arg n "$name" --arg ip "$OBS_TS_IP" \
    '{type:"A", name:$n, content:$ip, ttl:1, proxied:false}')

  if [ -z "$existing" ]; then
    curl -fsS -X POST \
      -H "Authorization: Bearer ${CF_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$payload" \
      "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
      >/dev/null
    ok "Cloudflare DNS record created"
  else
    local id current_ip
    id=$(echo "$existing" | jq -r '.id')
    current_ip=$(echo "$existing" | jq -r '.content')
    if [ "$current_ip" = "$OBS_TS_IP" ]; then
      ok "Cloudflare DNS record already current ($name → $OBS_TS_IP)"
    else
      curl -fsS -X PATCH \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        --data "$payload" \
        "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${id}" \
        >/dev/null
      ok "Cloudflare DNS record updated ($current_ip → $OBS_TS_IP)"
    fi
  fi
}
