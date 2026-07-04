# Lectorium social-poster service (Go).
# Built from the workspace `modules/` context (matches auth/share-audio).

# ── Stage 1: build ─────────────────────────────────────────────────────
FROM golang:1.24-alpine AS build
WORKDIR /src

COPY services/social-poster/go.mod services/social-poster/go.sum ./
RUN go mod download

COPY services/social-poster/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/social-poster ./cmd/social-poster

# ── Stage 2: runtime ───────────────────────────────────────────────────
FROM alpine:3.20

# curl for the compose healthcheck, ca-certificates for outbound TLS
# (CDN, share-audio, Telegram/VK/Facebook), tini for PID-1 signals.
RUN apk add --no-cache curl ca-certificates tini && \
    addgroup -g 1000 poster && \
    adduser -D -u 1000 -G poster poster && \
    mkdir -p /var/lib/social-poster && chown poster:poster /var/lib/social-poster

COPY --from=build /out/social-poster /usr/local/bin/social-poster

USER poster

ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME \
    CONFIG_PATH=/etc/social-poster/config.yaml

EXPOSE 8090

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/social-poster"]
