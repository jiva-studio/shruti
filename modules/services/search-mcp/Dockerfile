# Lectorium search-mcp — Go, multi-stage, FROM scratch (~15 MB final image).
#
# Built from the workspace `modules/` context by infra/app/compose/docker-compose.yml,
# i.e. paths in COPYs below are rooted at modules/.

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY services/search-mcp/go.mod services/search-mcp/go.sum ./
RUN go mod download
COPY services/search-mcp/ ./
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.buildSHA=${LECTORIUM_BUILD_SHA} -X main.buildTime=${LECTORIUM_BUILD_TIME}" \
    -o /out/search-mcp ./cmd/search-mcp

FROM scratch
COPY --from=build /out/search-mcp /search-mcp
# CA roots so the query embedder can reach OpenRouter/OpenAI over TLS.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME
EXPOSE 8086
ENTRYPOINT ["/search-mcp"]
