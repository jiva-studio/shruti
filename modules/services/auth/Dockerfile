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
# Migrations are embedded in the binary via go:embed — nothing to COPY.
EXPOSE 8081
ENTRYPOINT ["/auth"]
