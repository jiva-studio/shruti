# Shared Caddy build for both app and observability stacks.
# Plugins:
#   - caddy-ratelimit  — IP/key-bucketed in-memory rate-limit (app prod)
#   - caddy-dns/cloudflare — DNS-01 ACME for wildcard TLS behind Tailscale (obs)
# Each stack opt-in via its Caddyfile; unused plugin is dead weight.

FROM caddy:2.10-builder AS builder
RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2.10-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
# Bake the app Caddyfile in so CORS / rate-limit / route changes ride
# the normal CI → Watchtower path without an out-of-band SSH rsync.
# The obs stack reuses this same image but overrides /etc/caddy/Caddyfile
# via bind-mount with its own envsubst-rendered file.
COPY Caddyfile /etc/caddy/Caddyfile
# Role snippets — Caddyfile imports role-{$SHRUTI_REGION_ROLE}.conf
# at runtime so the same image deploys to origin (global) and proxy (RU).
# Working dir is /etc/caddy by default in caddy:alpine, so the relative
# imports resolve next to Caddyfile.
COPY role-origin.conf /etc/caddy/role-origin.conf
COPY role-proxy.conf /etc/caddy/role-proxy.conf

# Parse the config at build time, once per role. Nothing else checks it:
# the file is baked in and Watchtower rolls the container as soon as CI
# publishes, so a syntax error would reach the edge unattended and stop
# Caddy from starting. Values here are throwaway — the adapter only has
# to substitute something syntactically valid, exactly as compose does
# for SHRUTI_GLOBAL_HOST on origin hosts.
RUN set -eu; \
    for role in origin proxy; do \
        DOMAIN=validate.invalid \
        ACME_EMAIL=validate@invalid \
        SHRUTI_REGION_ROLE="$role" \
        SHRUTI_GLOBAL_HOST=global.invalid \
        SHRUTI_MCP_DOMAIN=mcp.invalid \
        SHRUTI_WEB_DOMAIN=web.invalid \
        SHRUTI_TRUSTED_PROXIES=127.0.0.1/32 \
        caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile; \
    done
