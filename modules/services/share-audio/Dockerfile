# Shruti share-audio service (Go).
# Built from the workspace `modules/` context (matches auth/chat).

# ── Stage 1: build ─────────────────────────────────────────────────────
FROM golang:1.24-alpine AS build
WORKDIR /src

# Manifest first so the dep-download layer caches across source-only edits.
COPY services/share-audio/go.mod services/share-audio/go.sum ./
RUN go mod download

COPY services/share-audio/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/share-audio ./cmd/share-audio

# ── Stage 2: runtime ───────────────────────────────────────────────────
FROM alpine:3.20

# ffmpeg for the cut, curl for compose healthcheck, ca-certificates for
# S3 TLS, tini for proper PID-1 signal forwarding to the Go process.
RUN apk add --no-cache ffmpeg curl ca-certificates tini && \
    addgroup -g 1000 share && \
    adduser -D -u 1000 -G share share

COPY --from=build /out/share-audio /usr/local/bin/share-audio

USER share

EXPOSE 8082

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/share-audio"]
