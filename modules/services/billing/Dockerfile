# Shruti billing service — Go, multi-stage, FROM scratch (~15 MB final image).
#
# Built from the workspace `modules/` context (same as auth), i.e. paths in the
# COPYs below are rooted at modules/.

FROM golang:1.25-alpine AS build
WORKDIR /src
# The shared token library is reached through `replace ../../libs/authjwt`, so
# the service sits at the same depth under /src as it does in the repository.
COPY libs/authjwt/ ./libs/authjwt/
COPY services/billing/go.mod services/billing/go.sum ./services/billing/
WORKDIR /src/services/billing
RUN go mod download
COPY services/billing/ ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/billing ./cmd/billing

FROM scratch
COPY --from=build /out/billing /billing
# CA roots so /billing can reach Paymento over TLS.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Build stamps surfaced on /billing/healthz — CI passes both as --build-arg.
ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
ENV SHRUTI_BUILD_SHA=$SHRUTI_BUILD_SHA \
    SHRUTI_BUILD_TIME=$SHRUTI_BUILD_TIME
EXPOSE 8082
ENTRYPOINT ["/billing"]
