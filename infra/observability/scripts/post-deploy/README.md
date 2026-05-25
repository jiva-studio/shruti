# Post-deploy hooks (observability)

Scripts here run on every `deploy.sh` invocation, in lexicographic order,
AFTER `docker compose up -d` and the inline healthchecks have completed.

Mirrors the convention from `infra/app/scripts/post-deploy/README.md` — see
PR #612 for the app-stack equivalent.

## Rules

1. **Idempotent**. Must succeed when run twice in a row with no changes.
   Re-applying the same TTL, re-upserting the same contact point, etc., must
   all be no-ops at the engine level.
2. **Self-skip when no-op**. If the change is already applied, exit 0 with a
   clear log line.
3. **Order via numeric prefix**: `010-`, `020-`, ... — lex-sort.
4. **Exit 0 = success or no-op**. Non-zero = real error, deploy halts.
5. **Standalone**. No shared state between scripts. Each owns its concern.
6. **Logs to stdout**. The `deploy.sh` wrapper captures and prints them.
7. **Graceful waits**. Stack components may still be migrating when the hook
   fires (Langfuse runs ClickHouse migrations on first boot, Grafana provisions
   contact points asynchronously). Hooks should retry briefly, then either
   no-op-skip or exit non-zero with a clear message — never hang the deploy.

## When to use this directory vs alternatives

- **One-time host setup** (DNS bootstrap, initial secret generation): keep in
  `infra/observability/scripts/configure.sh` and `lib/bootstrap-*.sh`.
- **Recurring infra config** that should be re-asserted on every deploy
  (Langfuse TTL, Grafana contact-point re-verify): HERE.

## Execution context

Hooks run **on the observability host** (the same VPS that `deploy.sh`
targets), invoked over SSH by the `deploy.sh` wrapper after `docker compose
up -d`. They have direct access to the host's docker socket, so
`docker exec lectorium-observability-clickhouse-1 …` and similar work
directly — no `ssh_run` indirection required from inside the hook.

This mirrors the app-stack pattern: each hook is self-contained and assumes
the deployed layout (`/opt/lectorium-observability/scripts/post-deploy/…`).
Hooks DO NOT reach for `infra/shared/lib/` — that path doesn't exist on the
host (the shared lib lands at `$REMOTE_DIR/_shared/`, but hooks are meant to
work without it anyway).

Hook-visible state on the host:

- Container names follow compose v2 naming with the project name set in
  `compose/docker-compose.yml` (`name: lectorium-observability`), e.g.
  `lectorium-observability-grafana-1`, `lectorium-observability-clickhouse-1`.
- The runtime `.env` written by `deploy.sh` step 5 lives at
  `$REMOTE_DIR/compose/.env` (relative to a hook: `../../compose/.env`).
  Hooks that need `GRAFANA_ADMIN_PASSWORD` / `TG_BOT_TOKEN` / etc. should
  read this file directly rather than relying on the operator's env.
- If a hook needs a sibling helper, prefer co-deploying it under
  `scripts/lib/` and sourcing via `"$HERE/../lib/<lib>.sh"` (paths resolve
  against the deployed layout). Don't reach into `_shared/`.

## Adding a new hook

1. Create `NNN-short-name.sh` (executable, `#!/usr/bin/env bash`, `set -euo pipefail`).
2. Keep it self-contained: `docker exec` against named containers, read
   secrets from `$REMOTE_DIR/compose/.env` if needed, no library sourcing
   beyond `scripts/lib/`.
3. Make the underlying change idempotent at the engine level (CREATE IF
   NOT EXISTS, `ALTER … MODIFY TTL` with same value is a no-op, etc.).
4. Validate with `bash -n infra/observability/scripts/post-deploy/NNN-short-name.sh`.
5. Run a deploy twice and confirm the second hook execution is a no-op.

## Relationship to `configure.sh`

`configure.sh` predates this directory and is kept for **first-time setup**:
Cloudflare DNS record creation, materialising `langfuse-keys.env` for the
chat service, smoke-verifying the stack. The recurring pieces it used to also
cover (Langfuse TTL, Grafana contact-point re-check) are now invoked
automatically by these post-deploy hooks on every `deploy.sh` run, so operators
no longer need to remember to re-run `configure.sh` after each deploy just to
re-assert TTL.
