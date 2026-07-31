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
#
# yt-dlp comes from PyPI, NOT `apk add yt-dlp`: the Alpine package is pinned to
# the distro release (3.21 ships 2025.03.31) and YouTube breaks extractors every
# few weeks. Measured on that version: signature extraction fails, the native
# audio format is skipped and the download silently degrades to a 38-fragment
# HLS fallback. It still produced a file, so the failure is invisible in the
# happy path right up until the release where it isn't. Bump YTDLP_VERSION on a
# cadence; a stale pin here is the single most likely cause of "YouTube stopped
# working".
#
# nodejs is required, not optional: yt-dlp 2026.07.04 needs a JavaScript runtime
# to solve YouTube's `nsig` player challenge. Without one its debug prints
# `No supported JavaScript runtime could be found` and it degrades to player
# clients that return `LOGIN_REQUIRED` / bot-check. deno is yt-dlp's default but
# Alpine only packages deno 2.0.6 which this yt-dlp rejects as unsupported, and
# deno ships no musl build; node works natively on musl and yt-dlp accepts it, so
# /etc/yt-dlp.conf pins `--js-runtimes node`. Measured 2026-07-29: a residential
# egress downloads cleanly with this; the datacenter IP is bot-checked
# regardless (that is what LECTORIUM_YTDLP_PROXY is for), so node alone is
# necessary but not sufficient without a residential proxy.
#
# `--remote-components ejs:github` is ALSO required (added 2026-07-31): a JS
# runtime is only half of it — yt-dlp needs the actual EJS challenge-solver
# script, which it does NOT bundle. Without this flag it logs `Remote component
# challenge solver script (node) was skipped` and STILL fails the `n` challenge,
# so every YouTube fetch dies with the misleading `This video is not available`
# even through the residential proxy. Measured 2026-07-31: node + this flag
# resolves a real lecture that failed on all 6 attempts before. The solver is
# fetched from GitHub on first use and cached in the container.
FROM alpine:3.21
ARG YTDLP_VERSION=2026.7.4
RUN apk add --no-cache ffmpeg ca-certificates python3 py3-pip nodejs \
    && pip install --no-cache-dir --break-system-packages "yt-dlp==${YTDLP_VERSION}" \
    && printf -- '--js-runtimes node\n--remote-components ejs:github\n' > /etc/yt-dlp.conf
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
