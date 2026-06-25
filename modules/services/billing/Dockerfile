# Lectorium billing service — Go, multi-stage, FROM scratch (~15 MB final image).
#
# Built from the workspace `modules/` context (same as auth), i.e. paths in the
# COPYs below are rooted at modules/.

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY services/billing/go.mod services/billing/go.sum ./
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
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME
EXPOSE 8082
ENTRYPOINT ["/billing"]
