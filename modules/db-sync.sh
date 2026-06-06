#!/usr/bin/env bash
#
# Shruti DB sync — thin wrapper over the shared, parametrized kit script
# (modules/kit/scripts/db-sync.sh). It supplies Shruti's app name, CDN URL,
# scheme file and dist targets; all sync logic (scheme selection, caching,
# stale cleanup, distribution) lives in the kit script.
#
# Scheme version is read from `db-scheme.json` — the single source of truth,
# also consumed by the mobile Vite config at build time.
#
# Usage:
#   bash modules/db-sync.sh [android|ios|e2e|all]
# Default target is `all`.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export APP_NAME="shruti"
export CDN_URL="https://cdn-s3.shruti.local"
export CONFIG_PATH="public/config.json"
export DB_PATH_PREFIX="public/db"
export SCHEME_FILE="${HERE}/db-scheme.json"
export CACHE_DIR="${HERE}/.db-cache"

export ANDROID_DIR="${HERE}/apps/mobile/android/app/src/main/assets/databases"
export IOS_DIR="${HERE}/apps/mobile/ios/App/App/databases"
export E2E_DB_DIR="${HERE}/tests/e2e/fixtures/public/db"
export E2E_CONFIG="${HERE}/tests/e2e/fixtures/public/config.json"

exec bash "${HERE}/kit/scripts/db-sync.sh" "${1:-all}"
