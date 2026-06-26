# Shruti storage-sync service (Go).
# Mirrors Bunny Edge Storage -> Yandex Object Storage. Built from the workspace
# `modules/` context (matches share-audio/share-video).

# ── Stage 1: build ─────────────────────────────────────────────────────
FROM golang:1.24-alpine AS build
WORKDIR /src

COPY services/storage-sync/go.mod services/storage-sync/go.sum ./
RUN go mod download

COPY services/storage-sync/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/storage-sync ./cmd/storage-sync

# ── Stage 2: runtime ───────────────────────────────────────────────────
FROM alpine:3.20

# curl for compose healthcheck, ca-certificates for Bunny + Yandex TLS,
# tini for proper PID-1 signal forwarding.
RUN apk add --no-cache curl ca-certificates tini && \
    addgroup -g 1000 sync && \
    adduser -D -u 1000 -G sync sync

COPY --from=build /out/storage-sync /usr/local/bin/storage-sync

USER sync

ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
ENV SHRUTI_BUILD_SHA=$SHRUTI_BUILD_SHA \
    SHRUTI_BUILD_TIME=$SHRUTI_BUILD_TIME

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/storage-sync"]
