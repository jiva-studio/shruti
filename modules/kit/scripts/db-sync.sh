#!/usr/bin/env bash
#
# Parametrized DB sync: downloads the latest compatible production content
# database from a CDN and distributes it to bundled-DB consumers (android/ios
# native assets, e2e fixtures).
#
# Generic: every input is supplied via env vars or flags, so any app can call
# it. Behavior is identical to a per-app script — select the newest DB whose
# `scheme` matches the local scheme file, cache it, distribute it, and remove
# stale copies so lexicographic pickup never returns an old file.
#
# The scheme version is read from the scheme file (`SCHEME_FILE`, JSON with a
# `.scheme` field) — the single source of truth, typically also consumed by the
# app's build config. Bumping the scheme in one place updates every consumer on
# the next sync.
#
# Files on the CDN are expected at:
#   ${CDN_URL}/${CONFIG_PATH}                  -> config.json (lists .databases[])
#   ${CDN_URL}/${DB_PATH_PREFIX}/${APP_NAME}.<version>.db
# and config.json is shaped like:
#   { "databases": [ { "scheme": <int>, "version": <int> }, ... ] }
#
# Usage:
#   db-sync.sh [android|ios|e2e|all]
# Default target is `all`.
#
# Required env:
#   APP_NAME       Basename of the DB files (e.g. "myapp").
#   CDN_URL        Base CDN/S3 URL (no trailing slash).
#   SCHEME_FILE    Path to the JSON scheme file (with a `.scheme` field).
#
# Optional env (with defaults):
#   CONFIG_PATH    Path of config.json on the CDN (default "public/config.json").
#   DB_PATH_PREFIX Path prefix of the .db files on the CDN (default "public/db").
#   CACHE_DIR      Local download cache (default "<scheme-file-dir>/.db-cache").
#   ANDROID_DIR    Android assets databases dir (required for android/all).
#   IOS_DIR        iOS App databases dir (required for ios/all).
#   E2E_DB_DIR     e2e fixtures db dir (required for e2e/all).
#   E2E_CONFIG     e2e fixtures config.json path (required for e2e/all).

set -euo pipefail

TARGET="${1:-all}"

die() {
  echo "[db-sync] ERROR: $1" >&2
  exit "${2:-1}"
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    die "required env var '${name}' is not set"
  fi
}

require_env APP_NAME
require_env CDN_URL
require_env SCHEME_FILE

CONFIG_PATH="${CONFIG_PATH:-public/config.json}"
DB_PATH_PREFIX="${DB_PATH_PREFIX:-public/db}"

if [ ! -f "${SCHEME_FILE}" ]; then
  die "scheme file not found at ${SCHEME_FILE}"
fi
SCHEME_DIR="$(cd "$(dirname "${SCHEME_FILE}")" && pwd)"
CACHE_DIR="${CACHE_DIR:-${SCHEME_DIR}/.db-cache}"

SUPPORTED_SCHEME=$(jq -r .scheme "${SCHEME_FILE}")
if [ -z "${SUPPORTED_SCHEME}" ] || [ "${SUPPORTED_SCHEME}" = "null" ]; then
  die "could not read .scheme from ${SCHEME_FILE}"
fi

echo "[db-sync] App: ${APP_NAME}"
echo "[db-sync] Target: ${TARGET}"
echo "[db-sync] Supported scheme: ${SUPPORTED_SCHEME}"
echo "[db-sync] Fetching config from ${CDN_URL}/${CONFIG_PATH}..."

CONFIG_BODY=$(curl -fsSL "${CDN_URL}/${CONFIG_PATH}")

VERSION=$(echo "${CONFIG_BODY}" | jq -r \
  "[.databases[] | select(.scheme == ${SUPPORTED_SCHEME})] | max_by(.version) | .version")

if [ -z "${VERSION}" ] || [ "${VERSION}" = "null" ]; then
  die "no database on CDN for scheme ${SUPPORTED_SCHEME}"
fi

echo "[db-sync] Latest compatible version: ${VERSION}"

mkdir -p "${CACHE_DIR}"
CACHED_DB="${CACHE_DIR}/${APP_NAME}.${VERSION}.db"
CACHED_CONFIG="${CACHE_DIR}/config.json"

if [ -f "${CACHED_DB}" ]; then
  echo "[db-sync] Using cached DB: ${CACHED_DB}"
else
  echo "[db-sync] Downloading ${CDN_URL}/${DB_PATH_PREFIX}/${APP_NAME}.${VERSION}.db..."
  curl -fSL --progress-bar "${CDN_URL}/${DB_PATH_PREFIX}/${APP_NAME}.${VERSION}.db" -o "${CACHED_DB}.part"
  mv "${CACHED_DB}.part" "${CACHED_DB}"
fi

# Always refresh the cached config (cheap, plain text, tracks CDN).
echo "${CONFIG_BODY}" > "${CACHED_CONFIG}"

distribute_to_dir() {
  local dir="$1"
  local label="$2"
  if [ -z "${dir}" ]; then
    die "${label} target requested but its directory env var is not set"
  fi
  mkdir -p "${dir}"
  # Remove any stale <app>.*.db in the target so lexicographic pickup never
  # returns an old file after a scheme bump.
  find "${dir}" -maxdepth 1 -type f -name "${APP_NAME}.*.db" ! -name "${APP_NAME}.${VERSION}.db" -delete
  cp -f "${CACHED_DB}" "${dir}/${APP_NAME}.${VERSION}.db"
  echo "[db-sync] ${label}: ${dir}/${APP_NAME}.${VERSION}.db"
}

distribute_e2e_config() {
  if [ -z "${E2E_CONFIG:-}" ]; then
    die "e2e target requested but E2E_CONFIG is not set"
  fi
  mkdir -p "$(dirname "${E2E_CONFIG}")"
  cp -f "${CACHED_CONFIG}" "${E2E_CONFIG}"
  echo "[db-sync] e2e config: ${E2E_CONFIG}"
}

case "${TARGET}" in
  android)
    distribute_to_dir "${ANDROID_DIR:-}" "android"
    ;;
  ios)
    distribute_to_dir "${IOS_DIR:-}" "ios"
    ;;
  e2e)
    distribute_to_dir "${E2E_DB_DIR:-}" "e2e"
    distribute_e2e_config
    ;;
  all)
    distribute_to_dir "${ANDROID_DIR:-}" "android"
    distribute_to_dir "${IOS_DIR:-}" "ios"
    distribute_to_dir "${E2E_DB_DIR:-}" "e2e"
    distribute_e2e_config
    ;;
  *)
    die "unknown target '${TARGET}' (expected android|ios|e2e|all)" 2
    ;;
esac

echo "[db-sync] Done."
