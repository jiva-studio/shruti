# Post-deploy hooks

Scripts here run on every `deploy.sh` invocation, in lexicographic order,
AFTER `docker compose up -d` completes successfully.

## Rules

1. **Idempotent**. Must succeed when run twice in a row with no changes.
   Use `CREATE IF NOT EXISTS`, `ALTER ... DO NOTHING`, conditional checks.
2. **Self-skip when no-op**. If the change is already applied, exit 0 with
   a log line like `→ NAME: already applied, skipping`.
3. **Order via numeric prefix**: `010-`, `020-`, ... — lex-sort.
4. **Exit 0 = success or no-op**. Non-zero = real error, deploy halts.
5. **Standalone**. No shared state between scripts. Each owns its concern.
6. **Logs to stdout**. The deploy.sh wrapper captures these.

## When to use this directory vs alternatives

- **DB migrations** (forward-only schema changes): `infra/app/db/migrations/`
- **One-time host setup** (install docker, generate keys): `infra/app/scripts/bootstrap/`
- **Recurring infra config**: HERE

## Execution context

Hooks run on the **app host** (the same VPS that `deploy.sh` targets), inside
an SSH session, with `$REMOTE_DIR` (`/opt/lectorium`) as the working directory's
parent. They have access to the host's docker socket, so `docker exec
lectorium-postgres ...` and similar work directly.

What they CANNOT reach without explicit network/SSH plumbing:
- The **observability host** (Loki/Tempo/Grafana/ClickHouse for Langfuse) —
  that's a separate stack with its own deploy. Cross-host infra config belongs
  in `infra/observability/scripts/`, not here.

## Adding a new hook

1. Create `NNN-short-name.sh` (executable, `#!/usr/bin/env bash`, `set -euo pipefail`).
2. Make the actual change idempotent at the engine level (CREATE IF NOT EXISTS,
   `MODIFY TTL` with same value is a no-op, etc.).
3. Echo what you're doing so it shows up in deploy logs.
4. Validate with `bash -n infra/app/scripts/post-deploy/NNN-short-name.sh`.
5. Run it twice locally (or against a staging host) and confirm the second run
   is a no-op.

## Example

See `010-example.sh` — a placeholder demonstrating the convention. Delete or
replace with real work as soon as a real hook is needed.
