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

Unlike the app stack hooks (which run **on** the remote host inside an SSH
session), observability hooks run **from the operator's machine** as part of
`deploy.sh`. This is intentional:

- The lib scripts they wrap (`lib/bootstrap-langfuse-ttl.sh`,
  `lib/bootstrap-grafana-contacts.sh`) already use `ssh_run` to reach the
  observability host and `docker exec` containers there.
- Some hooks need operator-local config (`CF_API_TOKEN`, `GRAFANA_ADMIN_PASSWORD`,
  `TG_BOT_TOKEN`) loaded from `config/<region>.env` before invocation.

The deploy.sh wrapper exports the needed env vars and `SSH_TARGET` / `SSH_OPTS`
/ `REMOTE_DIR` before iterating the hooks.

## Adding a new hook

1. Create `NNN-short-name.sh` (executable, `#!/usr/bin/env bash`, `set -euo pipefail`).
2. Source `infra/shared/lib/deploy-common.sh` (for `log`/`ok`/`warn`/`fail` and
   `ssh_run`).
3. Source the lib that does the work; call its function.
4. Make the underlying change idempotent at the engine level (CREATE IF NOT EXISTS,
   `ALTER … MODIFY TTL` with same value is a no-op, etc.).
5. Validate with `bash -n infra/observability/scripts/post-deploy/NNN-short-name.sh`.
6. Run a deploy twice and confirm the second hook execution is a no-op.

## Relationship to `configure.sh`

`configure.sh` predates this directory and is kept for **first-time setup**:
Cloudflare DNS record creation, materialising `langfuse-keys.env` for the
chat service, smoke-verifying the stack. The recurring pieces it used to also
cover (Langfuse TTL, Grafana contact-point re-check) are now invoked
automatically by these post-deploy hooks on every `deploy.sh` run, so operators
no longer need to remember to re-run `configure.sh` after each deploy just to
re-assert TTL.
