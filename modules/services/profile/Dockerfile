# Shruti profile service — Go, multi-stage, FROM scratch (~15 MB final image).
#
# Built from the workspace `modules/` context by infra/compose/docker-compose.yml,
# i.e. paths in COPYs below are rooted at modules/.
#
# The one-shot `profile migrate` and the long-running `profile serve` are the
# SAME image with different args — compose runs migrate to completion, then
# starts serve (which refuses traffic until the schema is current).

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY services/profile/go.mod services/profile/go.sum ./
RUN go mod download
COPY services/profile/ ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/profile ./cmd/profile

FROM scratch
COPY --from=build /out/profile /profile
# CA roots — not strictly needed today (profile talks only to its own PG over
# the internal network), kept for parity so future outbound TLS just works.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Migrations are embedded in the binary via go:embed — nothing to COPY.
# Build stamps surfaced on /healthz — CI passes both as --build-arg.
ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
ENV SHRUTI_BUILD_SHA=$SHRUTI_BUILD_SHA \
    SHRUTI_BUILD_TIME=$SHRUTI_BUILD_TIME
EXPOSE 8085
ENTRYPOINT ["/profile"]
CMD ["serve"]
