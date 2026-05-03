#!/usr/bin/env bash
#
# Shared DB sync: downloads the latest compatible production content
# database from the S3 CDN and distributes it to every bundled-DB
# consumer in the monorepo (android/ios native assets, e2e fixtures).
#
# Scheme version is read from `db-scheme.json` — the single source of
# truth, also consumed by the mobile Vite config at build time. Bumping
# the scheme in one place updates every consumer on the next sync.
#
# Usage:
#   bash modules/db-sync.sh [android|ios|e2e|all]
#
# Default target is `all`.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
TARGET="${1:-all}"

CDN_URL="https://cdn-s3.shruti.local"
CONFIG_PATH="public/config.json"
SCHEME_FILE="${HERE}/db-scheme.json"
CACHE_DIR="${HERE}/.db-cache"

ANDROID_DIR="${HERE}/apps/mobile/android/app/src/main/assets/databases"
IOS_DIR="${HERE}/apps/mobile/ios/App/App/databases"
E2E_DB_DIR="${HERE}/tests/e2e/fixtures/public/db"
E2E_CONFIG="${HERE}/tests/e2e/fixtures/public/config.json"

if [ ! -f "${SCHEME_FILE}" ]; then
  echo "[db-sync] ERROR: scheme file not found at ${SCHEME_FILE}" >&2
  exit 1
fi

SUPPORTED_SCHEME=$(jq -r .scheme "${SCHEME_FILE}")
if [ -z "${SUPPORTED_SCHEME}" ] || [ "${SUPPORTED_SCHEME}" = "null" ]; then
  echo "[db-sync] ERROR: could not read .scheme from ${SCHEME_FILE}" >&2
  exit 1
fi

echo "[db-sync] Target: ${TARGET}"
echo "[db-sync] Supported scheme: ${SUPPORTED_SCHEME}"
echo "[db-sync] Fetching config from ${CDN_URL}/${CONFIG_PATH}..."

CONFIG_BODY=$(curl -fsSL "${CDN_URL}/${CONFIG_PATH}")

VERSION=$(echo "${CONFIG_BODY}" | jq -r \
  "[.databases[] | select(.scheme == ${SUPPORTED_SCHEME})] | max_by(.version) | .version")

if [ -z "${VERSION}" ] || [ "${VERSION}" = "null" ]; then
  echo "[db-sync] ERROR: no database on CDN for scheme ${SUPPORTED_SCHEME}" >&2
  exit 1
fi

echo "[db-sync] Latest compatible version: ${VERSION}"

mkdir -p "${CACHE_DIR}"
CACHED_DB="${CACHE_DIR}/shruti.${VERSION}.db"
CACHED_CONFIG="${CACHE_DIR}/config.json"

if [ -f "${CACHED_DB}" ]; then
  echo "[db-sync] Using cached DB: ${CACHED_DB}"
else
  echo "[db-sync] Downloading ${CDN_URL}/public/db/shruti.${VERSION}.db..."
  curl -fSL --progress-bar "${CDN_URL}/public/db/shruti.${VERSION}.db" -o "${CACHED_DB}.part"
  mv "${CACHED_DB}.part" "${CACHED_DB}"
fi

# Always refresh the cached config (cheap, plain text, tracks CDN).
echo "${CONFIG_BODY}" > "${CACHED_CONFIG}"

distribute_to_dir() {
  local dir="$1"
  local label="$2"
  mkdir -p "${dir}"
  # Remove any stale shruti.*.db in the target so lexicographic pickup
  # never returns an old file after a scheme bump.
  find "${dir}" -maxdepth 1 -type f -name 'shruti.*.db' ! -name "shruti.${VERSION}.db" -delete
  cp -f "${CACHED_DB}" "${dir}/shruti.${VERSION}.db"
  echo "[db-sync] ${label}: ${dir}/shruti.${VERSION}.db"
}

case "${TARGET}" in
  android)
    distribute_to_dir "${ANDROID_DIR}" "android"
    ;;
  ios)
    distribute_to_dir "${IOS_DIR}" "ios"
    ;;
  e2e)
    distribute_to_dir "${E2E_DB_DIR}" "e2e"
    cp -f "${CACHED_CONFIG}" "${E2E_CONFIG}"
    echo "[db-sync] e2e config: ${E2E_CONFIG}"
    ;;
  all)
    distribute_to_dir "${ANDROID_DIR}" "android"
    distribute_to_dir "${IOS_DIR}" "ios"
    distribute_to_dir "${E2E_DB_DIR}" "e2e"
    cp -f "${CACHED_CONFIG}" "${E2E_CONFIG}"
    echo "[db-sync] e2e config: ${E2E_CONFIG}"
    ;;
  *)
    echo "[db-sync] ERROR: unknown target '${TARGET}' (expected android|ios|e2e|all)" >&2
    exit 2
    ;;
esac

echo "[db-sync] Done."
