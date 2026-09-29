# shruti-corpus-mcp — Go, multi-stage, FROM scratch (static, ~20 MB).
#
# SQLite access is pure-Go (modernc.org/sqlite), so the binary stays fully
# static (CGO_ENABLED=0) and the final image is scratch — no libc, no CGO.
#
# Built from the workspace `modules/` context: the COPY
# paths below are rooted at modules/.

FROM golang:1.25-alpine AS build
WORKDIR /src
# The service reads the published catalog formats through
# `replace github.com/jiva-studio/shruti/catalogdb => ../../libs/catalogdb`, so
# both trees are copied under /src with their relative layout intact.
COPY libs/catalogdb/ ./libs/catalogdb/
COPY services/shruti-corpus-mcp/ ./services/shruti-corpus-mcp/
WORKDIR /src/services/shruti-corpus-mcp
RUN go mod download
ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.buildSHA=${SHRUTI_BUILD_SHA} -X main.buildTime=${SHRUTI_BUILD_TIME}" \
    -o /out/corpus-mcp ./cmd/corpus-mcp

FROM scratch
COPY --from=build /out/corpus-mcp /corpus-mcp
# CA roots so the query embedder (OpenRouter/OpenAI) and the Bunny CDN
# artifact bootstrap can be reached over TLS.
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
ENV SHRUTI_BUILD_SHA=$SHRUTI_BUILD_SHA \
    SHRUTI_BUILD_TIME=$SHRUTI_BUILD_TIME \
    CORPUS_MCP_ADDR=0.0.0.0:8087 \
    CATALOG_DIR=/var/lib/corpus-mcp
# CATALOG_DIR must be a writable volume (the SQLite artifacts are downloaded
# and atomically swapped there). Mount it in compose alongside a read-only
# rootfs.
EXPOSE 8087
ENTRYPOINT ["/corpus-mcp"]
