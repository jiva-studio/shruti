# infra/observability/compose/caddy/Dockerfile
#
# Caddy built with the Cloudflare DNS plugin for Let's Encrypt DNS-01
# wildcard certificates. Built locally via xcaddy rather than relying on a
# third-party image (e.g. ghcr.io/caddybuilds/...) so the supply chain stops
# at the upstream caddy:builder image we already trust.
#
# Bump both FROM lines together to upgrade Caddy.
FROM caddy:2.8.4-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2.8.4-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
