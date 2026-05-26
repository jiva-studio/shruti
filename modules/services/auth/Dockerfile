# Shruti auth service — Go, multi-stage, FROM scratch (~15 MB final image).
#
# Built from the workspace `modules/` context by infra/compose/docker-compose.yml,
# i.e. paths in COPYs below are rooted at modules/.

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY services/auth/go.mod services/auth/go.sum ./
RUN go mod download
COPY services/auth/ ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /out/auth ./cmd/auth

FROM scratch
COPY --from=build /out/auth /auth
# CA roots so /auth can hit Google/Apple JWKS over TLS.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
# Profile-collection policy config — read at boot from CONFIG_PATH
# (default /etc/shruti/auth/config.yaml). PR-1.5a shipped the file
# in the repo but missed wiring it into the image; without this COPY
# the binary fail-boots in prod with profile_policy_load_failed.
COPY services/auth/config/config.yaml /etc/shruti/auth/config.yaml
# Migrations are embedded in the binary via go:embed — nothing to COPY.
# Build stamps surfaced on /healthz — CI passes both as --build-arg.
ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
ENV SHRUTI_BUILD_SHA=$SHRUTI_BUILD_SHA \
    SHRUTI_BUILD_TIME=$SHRUTI_BUILD_TIME
EXPOSE 8081
ENTRYPOINT ["/auth"]
