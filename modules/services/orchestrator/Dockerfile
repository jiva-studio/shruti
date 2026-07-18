# Lectorium orchestrator service — Go, multi-stage, FROM scratch.
#
# Built from the workspace `modules/` context by infra/app/compose/docker-compose.yml,
# i.e. paths in COPYs below are rooted at modules/.
#
# The one-shot `orchestrator migrate` and the long-running `orchestrator serve`
# are the SAME image with different args — compose runs migrate to completion,
# then starts serve (which refuses traffic until the schema is current).

# 1.26 (not 1.25 like the other services) because the shared pipeline module
# requires go >= 1.26.2.
FROM golang:1.26-alpine AS build
WORKDIR /src
# The service depends on the shared pipeline module via a local
# `replace github.com/jiva-studio/lectorium/pipeline => ../../libs/pipeline`,
# so that module must be present in the build context at the SAME relative
# location. Both trees are copied under /src preserving structure, so from the
# service dir `../../libs/pipeline` resolves to /src/libs/pipeline.
COPY libs/pipeline/ ./libs/pipeline/
COPY services/orchestrator/ ./services/orchestrator/
WORKDIR /src/services/orchestrator
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/orchestrator ./cmd/orchestrator

FROM scratch
COPY --from=build /out/orchestrator /orchestrator
# CA roots — the orchestrator makes outbound TLS calls (Deepgram, the proxy,
# S3/CDN) once the pipeline lands, so the bundle is required.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Migrations are embedded in the binary via go:embed — nothing to COPY.
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME
EXPOSE 8086
# FROM scratch has no shell/curl — the binary self-probes /healthz over
# localhost via the `healthz` subcommand (exit 0 healthy / 1 unhealthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/orchestrator", "healthz"]
ENTRYPOINT ["/orchestrator"]
CMD ["serve"]
