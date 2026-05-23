# infra/shared/

Common deploy helpers sourced by every `infra/<unit>/scripts/deploy.sh`
(`observability/`, `observability-agent/`, future `app/`). Pure bash, no
external runtime — `apt install jq rsync curl gettext-base` on the
deploy box is enough.

## Layout

```
shared/
├── lib/
│   ├── deploy-common.sh        # ssh_run, rsync_to_target, ensure_secrets,
│   │                           # compose_up, wait_healthcheck, report_urls,
│   │                           # ensure_target_host_ready
│   ├── render-templates.sh     # envsubst pass over *.template files
│   ├── tailscale-bootstrap.sh  # install + advertise tags
│   └── ssh-helpers.sh          # ssh-copy-id, sshd_config hardening
└── templates/
    ├── docker-daemon.json      # log rotation: max-size 50m, max-file 5
    └── ufw-rules.sh            # default-deny + allow ssh + allow tailscale0
```

## Usage in a deploy.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/shared/lib/deploy-common.sh"
source "$ROOT/shared/lib/render-templates.sh"

SSH_TARGET="root@$TARGET_IP"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -i ~/.ssh/id_ed25519)
REMOTE_DIR=/opt/lectorium-observability

ensure_target_host_ready
render_templates_in "$ROOT/observability/compose"
rsync_to_target "$ROOT/observability" "$REMOTE_DIR"
ensure_secrets "$REMOTE_DIR/secrets" \
  encryption_key:'openssl rand -hex 32' \
  nextauth_secret:'openssl rand -base64 32'
compose_up "$REMOTE_DIR"
wait_healthcheck http://localhost:3000/api/health 180 grafana
report_urls "Deployed" https://grafana.obs.eu.lectorium.akdasa.studio
```

## Conventions

- **Secrets are never overwritten** — `ensure_secrets` skips any key file
  whose remote path is non-empty. Re-generating `ENCRYPTION_KEY` would
  make all Langfuse API keys at-rest unreadable.
- **`rsync --delete` is on by default** — `secrets/` and `*.local.env` are
  excluded so a re-rsync doesn't clobber on-host state.
- **All bash files use `set -euo pipefail`**.
- **Idempotent**: re-running any helper is safe.
