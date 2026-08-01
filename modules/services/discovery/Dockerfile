# Lectorium discovery — Go, multi-stage, FROM scratch.
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

FROM scratch
COPY --from=build /out/discovery /discovery
# CA roots — every outbound call this service makes is TLS: the archives it
# reads and the model endpoint it normalizes through.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Migrations and prompts are embedded in the binary via go:embed.
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME
EXPOSE 8089
# FROM scratch has no shell/curl — the binary self-probes /healthz over
# localhost via the `healthz` subcommand (exit 0 healthy / 1 unhealthy).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["/discovery", "healthz"]
ENTRYPOINT ["/discovery"]
CMD ["serve"]
