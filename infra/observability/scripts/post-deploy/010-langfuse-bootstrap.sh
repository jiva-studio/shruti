#!/usr/bin/env bash
# infra/observability/scripts/post-deploy/010-langfuse-bootstrap.sh
#
# Re-asserts the 90-day TTL on the Langfuse ClickHouse tables on every
# deploy, so retention drift becomes impossible. `ALTER TABLE … MODIFY TTL`
# in ClickHouse is metadata-only when the TTL expression is unchanged, so
# this runs as a true no-op on steady-state deploys.
#
# Contract: see infra/observability/scripts/post-deploy/README.md
#   - idempotent
#   - self-skips when Langfuse / ClickHouse aren't ready yet (warns, returns 0)
#   - exits non-zero only on a structural failure (lib missing, env unset)
#
# Required env (set by deploy.sh before invocation):
#   SSH_TARGET, SSH_OPTS, REMOTE_DIR, REGION
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_LIB="$(cd "$HERE/../../../shared/lib" && pwd)"
OBS_LIB="$(cd "$HERE/../lib" && pwd)"

# shellcheck source=../../../shared/lib/deploy-common.sh
source "$SHARED_LIB/deploy-common.sh"

# These must be in the environment — deploy.sh exports them before the loop.
require_vars SSH_TARGET REMOTE_DIR REGION \
  || fail "010-langfuse-bootstrap: required env vars unset (call from deploy.sh)"

if [ -z "${SSH_OPTS+x}" ]; then
  fail "010-langfuse-bootstrap: SSH_OPTS array unset (call from deploy.sh)"
fi

# shellcheck source=../lib/bootstrap-langfuse-ttl.sh
source "$OBS_LIB/bootstrap-langfuse-ttl.sh"

log "post-deploy/010: applying Langfuse ClickHouse TTL"
bootstrap_langfuse_ttl
