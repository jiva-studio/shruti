# Shruti share-video service (Go). Long-running container that pulls
# render jobs from public.tasks (postgres queue) and produces 720p mp4
# reels.

# ── Stage 1: build ─────────────────────────────────────────────────────
FROM golang:1.25-alpine AS build
WORKDIR /src

# Manifest first so the dep-download layer caches across source-only edits.
COPY services/share-video/go.mod services/share-video/go.sum ./
RUN go mod download

COPY services/share-video/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/share-video ./cmd/share-video

# ── Stage 2: runtime ───────────────────────────────────────────────────
FROM alpine:3.20

# ffmpeg for the three render passes, curl for compose healthcheck,
# ca-certificates for outbound TLS (OpenAI / SpeechKit / S3), tini for
# proper PID-1 signal forwarding.
RUN apk add --no-cache ffmpeg curl ca-certificates tini && \
    addgroup -g 1000 share && \
    adduser -D -u 1000 -G share share && \
    mkdir -p /tmp/render && chown share:share /tmp/render

WORKDIR /app

COPY --from=build /out/share-video /usr/local/bin/share-video
# Assets (logo.mp4, icon.png, NotoSans-Bold.ttf) are looked up relative
# to cwd by main; keep them under /app/assets so the binary finds them.
COPY --from=build /src/assets/ /app/assets/

USER share

ENV FFMPEG_BIN=/usr/bin/ffmpeg \
    FFPROBE_BIN=/usr/bin/ffprobe \
    TEMP_ROOT=/tmp/render

EXPOSE 8083

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/share-video"]
