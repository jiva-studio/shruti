# Lectorium discovery — Go, multi-stage.
#
# Built from the workspace `modules/` context, so the COPYs below are rooted
# there. The shared pipeline module comes along because the normalizer uses its
# OpenAI-compatible client.
#
# The one-shot `discovery migrate` and the long-running `discovery serve` are
# the SAME image with different args — compose runs migrate to completion, then
# starts serve, which refuses traffic until the schema is current.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY libs/pipeline/ ./libs/pipeline/
COPY services/discovery/ ./services/discovery/
WORKDIR /src/services/discovery
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/discovery ./cmd/discovery

# Not scratch, because some archives cannot be read with an HTTP client alone.
# YouTube signs its caption URLs and hides the signature behind a JavaScript
# challenge, so reaching them means yt-dlp and a modern JS runtime.
#
# The alternative was to have this service ask another one to fetch for it. A
# crawler owns its fetching: it is what holds the politeness gap, the per-host
# limiter and the breaker, and handing a download to a worker queue would put
# all three somewhere they do not belong.
FROM alpine:3.21
RUN apk add --no-cache ca-certificates nodejs python3 py3-pip tini \
 && pip install --break-system-packages --no-cache-dir yt-dlp==2026.7.4 \
 && adduser -D -u 10001 discovery
COPY --from=build /out/discovery /discovery
# Migrations and prompts are embedded in the binary via go:embed.
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME
USER discovery
EXPOSE 8089
# The binary self-probes /healthz over localhost via the `healthz` subcommand
# (exit 0 healthy / 1 unhealthy), so the image needs no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/discovery", "healthz"]
# tini reaps yt-dlp: a crawl spawns one per video, and PID 1 in a container
# does not reap by default.
ENTRYPOINT ["/sbin/tini", "--", "/discovery"]
CMD ["serve"]
