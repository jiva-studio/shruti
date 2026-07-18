# Lectorium orchestrator service — Go, multi-stage, FROM scratch.
#
# Built from the workspace `modules/` context by infra/app/compose/docker-compose.yml,
# i.e. paths in COPYs below are rooted at modules/.
#
# The one-shot `orchestrator migrate` and the long-running `orchestrator serve`
# are the SAME image with different args — compose runs migrate to completion,
# then starts serve (which refuses traffic until the schema is current).

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY services/orchestrator/go.mod services/orchestrator/go.sum ./
RUN go mod download
COPY services/orchestrator/ ./
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
ENTRYPOINT ["/orchestrator"]
CMD ["serve"]
