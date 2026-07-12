# Shruti analytics service — Go, multi-stage, FROM scratch (~15 MB final image).
#
# Built from the workspace `modules/` context by infra/compose/docker-compose.yml,
# i.e. paths in COPYs below are rooted at modules/.
#
# Read-only reports over the profile Postgres. No migrations, no schema of its
# own — the single binary just serves HTTP.

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY services/analytics/go.mod services/analytics/go.sum ./
RUN go mod download
COPY services/analytics/ ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/analytics ./cmd/analytics

FROM scratch
COPY --from=build /out/analytics /analytics
# CA roots — analytics talks only to its own network PG today, kept for parity
# so future outbound TLS just works.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Build stamps surfaced on /healthz — CI passes both as --build-arg.
ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
ENV SHRUTI_BUILD_SHA=$SHRUTI_BUILD_SHA \
    SHRUTI_BUILD_TIME=$SHRUTI_BUILD_TIME
EXPOSE 8086
ENTRYPOINT ["/analytics"]
CMD ["serve"]
