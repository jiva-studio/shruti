# Host bootstrap scripts

One-time host setup scripts: install docker, generate keys, prepare directories,
seed initial credentials, etc. Run by hand (or by `deploy.sh`'s SSH bootstrap
step) when a VPS is first provisioned.

## Bootstrap vs post-deploy

- **Bootstrap (here)**: runs on a fresh host. Conceptually one-shot. Anything
  that creates host-level prerequisites for the stack to even start (docker,
  keypairs, mountpoints).
- **Post-deploy** (`../post-deploy/`): runs on EVERY deploy. Idempotent infra
  config — ClickHouse TTL, Grafana contacts, retention policies.

If you find yourself reaching for "but the bootstrap step needs to re-run when
X changes", that's a post-deploy hook, not a bootstrap script.

## Note

The current `infra/app/scripts/bootstrap.sh` predates this directory and stays
in place for now (it's invoked from `deploy.sh` via `bash -s <`). New bootstrap
scripts should land here; `bootstrap.sh` can migrate in a follow-up when
convenient.
