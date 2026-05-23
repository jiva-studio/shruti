# Shruti share-video service. Long-running Node container that pulls
# render jobs from public.tasks (postgres queue) and produces 720p mp4
# reels. Replaces the previous AWS Lambda / YC Cloud Function flow.

# ── Stage 1: build TypeScript ───────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Build needs the dev-deps (typescript, ts-node, type defs) — they don't
# travel into the runtime stage. `npm ci` runs a `postinstall` hook that
# copies font subsets out of node_modules/@fontsource/noto-sans into
# assets/fonts/ via scripts/copy-bundled-font.js, so scripts/ + assets/
# must land before `npm ci` even though they're not needed for the
# dependency tree itself.
COPY services/share-video/package.json services/share-video/package-lock.json ./
COPY services/share-video/tsconfig.json ./
COPY services/share-video/scripts/    ./scripts/
COPY services/share-video/assets/     ./assets/
RUN npm ci --no-audit --no-fund

COPY services/share-video/src/        ./src/
COPY services/share-video/pipeline.ts ./pipeline.ts
COPY services/share-video/storage.ts  ./storage.ts

RUN npm run build

# Drop dev deps for the runtime stage (smaller image).
RUN npm prune --omit=dev

# ── Stage 2: runtime ────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# ffmpeg for the render pipeline; curl for compose healthcheck; tini for
# proper signal forwarding to the node process.
RUN apk add --no-cache ffmpeg curl tini

# node:20-alpine ships a `node` user (uid 1000); we just need a writable
# scratch dir on the volume mount path.
RUN mkdir -p /tmp/render && chown -R node:node /tmp/render /app

USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --from=build --chown=node:node /app/assets       ./assets
COPY --from=build --chown=node:node /app/package.json ./package.json

# Default to bundled binaries (alpine apk installs there). Overridable in
# compose if needed.
ENV FFMPEG_BIN=/usr/bin/ffmpeg \
    FFPROBE_BIN=/usr/bin/ffprobe \
    TEMP_ROOT=/tmp/render

EXPOSE 8083

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/server.js"]
