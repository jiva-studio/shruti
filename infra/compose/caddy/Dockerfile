# Custom Caddy build with the rate-limit plugin baked in. Used by the
# prod overlay (docker-compose.prod.yml). Built and pushed to ghcr.io
# by services-ghcr.yml alongside the app images.
#
# Plugin: github.com/mholt/caddy-ratelimit — IP/key-bucketed in-memory
# token-bucket. Conf in Caddyfile global block.

FROM caddy:2.10-builder AS builder

# xcaddy compiles a fresh Caddy binary linked with the listed plugins.
# The base image already has xcaddy on PATH.
RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit

# Runtime is the standard alpine image; we just swap the binary.
FROM caddy:2.10-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
