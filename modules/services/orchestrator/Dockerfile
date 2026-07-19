# Shruti orchestrator service — Go, multi-stage, FROM scratch.
#
# Built from the workspace `modules/` context by infra/app/compose/docker-compose.yml,
# i.e. paths in COPYs below are rooted at modules/.
#
# The one-shot `orchestrator migrate` and the long-running `orchestrator serve`
# are the SAME image with different args — compose runs migrate to completion,
# then starts serve (which refuses traffic until the schema is current).

# The thin coordinator no longer depends on the shared pipeline module (the
# heavy fetch/transcribe/store adapters moved to the `ingest` worker), so the
# build context is just the service tree.
FROM golang:1.26-alpine AS build
WORKDIR /src/services/orchestrator
COPY services/orchestrator/ ./
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/orchestrator ./cmd/orchestrator

FROM scratch
COPY --from=build /out/orchestrator /orchestrator
# CA roots — kept for any outbound TLS (the broker is plaintext, but the bundle
# is harmless and future-proofs outbound calls).
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Migrations are embedded in the binary via go:embed — nothing to COPY.
ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
ENV SHRUTI_BUILD_SHA=$SHRUTI_BUILD_SHA \
    SHRUTI_BUILD_TIME=$SHRUTI_BUILD_TIME
EXPOSE 8086
# FROM scratch has no shell/curl — the binary self-probes /healthz over
# localhost via the `healthz` subcommand (exit 0 healthy / 1 unhealthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/orchestrator", "healthz"]
ENTRYPOINT ["/orchestrator"]
CMD ["serve"]
