#!/usr/bin/env bash
# Postgres → S3 backup. Run on the VPS, daily, via cron.
#
# Pipeline:
#   pg_dump --format=custom --no-owner --no-acl   # inside the postgres container
#     | gzip
#     | aws s3 cp - s3://<bucket>/private/backups/postgres/YYYY-MM-DD.sql.gz
#
# Format=custom is pg_restore-friendly (parallel restore, selective object
# restore). --no-owner / --no-acl strip role-specific bits so the dump is
# portable to a fresh cluster.
#
# Retention: S3 lifecycle policy on the prefix
# `private/backups/postgres/` should delete objects after 30 days. Not
# enforced here.
#
# Cron entry (root crontab on the VPS, set up once by operator):
#   0 3 * * * /opt/lectorium/infra/scripts/backup.sh >> /var/log/lectorium-backup.log 2>&1
#
# 03:00 UTC = 06:00 MSK = low-traffic window.

set -euo pipefail

ENV_FILE="${LECTORIUM_ENV_FILE:-/opt/lectorium/.env}"
PROJECT="lectorium"
PG_CONTAINER="${LECTORIUM_PG_CONTAINER:-${PROJECT}-postgres-1}"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE missing" >&2
  exit 1
fi

# Read S3 destination + AWS creds from the same env file the stack uses.
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${LECTORIUM_S3_BUCKET:?LECTORIUM_S3_BUCKET must be set in $ENV_FILE}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID must be set in $ENV_FILE}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY must be set in $ENV_FILE}"

DATE=$(date -u +%Y-%m-%d)
KEY="private/backups/postgres/${DATE}.sql.gz"
DEST="s3://${LECTORIUM_S3_BUCKET}/${KEY}"

# Sanity: postgres container must be up.
if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  echo "✗ postgres container '$PG_CONTAINER' not found" >&2
  exit 1
fi

echo "→ Dumping → $DEST"

# Stream the dump out of the container so we don't need any disk on the
# VPS for it. `docker exec` proxies stdout straight to gzip; gzip pipes
# to `aws s3 cp - <key>` which uploads via multipart automatically.
docker exec "$PG_CONTAINER" pg_dump \
    -U lectorium -d lectorium \
    --format=custom --no-owner --no-acl \
  | gzip -1 \
  | aws s3 cp \
      --region "${AWS_REGION:-us-east-1}" \
      --expected-size $((2 * 1024 * 1024 * 1024)) \
      - "$DEST"

echo "✓ Backup → $DEST"
