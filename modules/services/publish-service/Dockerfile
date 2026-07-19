# Lectorium publish-service — Go, multi-stage, FROM scratch.
#
# Built from the workspace `modules/` context by infra/app/compose/docker-compose.yml,
# i.e. paths in COPYs below are rooted at modules/.
#
# The one-shot `publish-service migrate` and the long-running
# `publish-service serve` are the SAME image with different args — compose runs
# migrate to completion, then starts serve (which refuses traffic until the
# schema is current).
#
# Unlike the orchestrator, publish-service has no dependency on the shared
# pipeline module, so the build context is just the service tree.
FROM golang:1.26-alpine AS build
WORKDIR /src/services/publish-service
COPY services/publish-service/ ./
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/publish-service ./cmd/publish-service

FROM scratch
COPY --from=build /out/publish-service /publish-service
# CA roots — publish-service makes outbound TLS calls (S3/CDN, the corpus
# catalog HTTP URL), so the bundle is required.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Migrations are embedded in the binary via go:embed — nothing to COPY.
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME
EXPOSE 8087
# FROM scratch has no shell/curl — the binary self-probes /healthz over
# localhost via the `healthz` subcommand (exit 0 healthy / 1 unhealthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/publish-service", "healthz"]
ENTRYPOINT ["/publish-service"]
CMD ["serve"]
