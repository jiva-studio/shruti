# Shruti cleanup-worker — Go, multi-stage, FROM scratch (~10 MB final image).
#
# Built from the workspace `modules/` context by
# infra/app/compose/docker-compose.dev.yml (and the services-ghcr.yml CI
# workflow). Paths in COPY are rooted at modules/.

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY services/cleanup-worker/go.mod services/cleanup-worker/go.sum ./
RUN go mod download
COPY services/cleanup-worker/ ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/cleanup-worker ./cmd/cleanup-worker

FROM scratch
COPY --from=build /out/cleanup-worker /cleanup-worker
# CA roots so the Langfuse REST client can hit https://langfuse.* over TLS.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Build stamps surfaced on /healthz — CI passes both as --build-arg.
ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
ENV SHRUTI_BUILD_SHA=$SHRUTI_BUILD_SHA \
    SHRUTI_BUILD_TIME=$SHRUTI_BUILD_TIME
EXPOSE 8090
ENTRYPOINT ["/cleanup-worker"]
