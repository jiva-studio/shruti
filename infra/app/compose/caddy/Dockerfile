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
# Role snippets — Caddyfile imports role-{$LECTORIUM_REGION_ROLE}.conf
# at runtime so the same image deploys to origin (global) and proxy (RU).
# Working dir is /etc/caddy by default in caddy:alpine, so the relative
# imports resolve next to Caddyfile.
COPY role-origin.conf /etc/caddy/role-origin.conf
COPY role-proxy.conf /etc/caddy/role-proxy.conf
