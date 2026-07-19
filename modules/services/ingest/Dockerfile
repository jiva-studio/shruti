# Lectorium ingest worker — Go, multi-stage.
#
# Built from the workspace `modules/` context by infra/app/compose/docker-compose.yml,
# i.e. paths in COPYs below are rooted at modules/.
#
# Unlike the other Go services this does NOT use a FROM-scratch final image:
# the worker shells out to `yt-dlp` (source download) and `ffmpeg` (audio
# extraction), so the runtime stage must carry both binaries.

# 1.26 because the shared pipeline module requires go >= 1.26.2.
FROM golang:1.26-alpine AS build
WORKDIR /src
# The worker depends on the shared pipeline module via a local
# `replace github.com/jiva-studio/lectorium/pipeline => ../../libs/pipeline`,
# so that module must be present in the build context at the SAME relative
# location. Both trees are copied under /src preserving structure, so from the
# service dir `../../libs/pipeline` resolves to /src/libs/pipeline.
COPY libs/pipeline/ ./libs/pipeline/
COPY services/ingest/ ./services/ingest/
WORKDIR /src/services/ingest
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/ingest ./cmd/ingest

# Runtime carries yt-dlp + ffmpeg (the fetch stage shells out to them) plus CA
# roots for outbound TLS (Deepgram, the proxy, S3/CDN).
FROM alpine:3.21
RUN apk add --no-cache yt-dlp ffmpeg ca-certificates
COPY --from=build /out/ingest /ingest
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME
EXPOSE 8088
# The binary self-probes /healthz over localhost via the `healthz` subcommand
# (exit 0 healthy / 1 unhealthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/ingest", "healthz"]
ENTRYPOINT ["/ingest"]
CMD ["serve"]
