# RevenueCat Webhook Secret Rotation

Operator runbook for rotating the Bearer secret that authenticates RevenueCat
webhook deliveries to `auth /webhooks/revenuecat`.

The auth service accepts **two** webhook secrets at once — `PRIMARY` and
`SECONDARY` — so a rotation can happen without dropping deliveries. Both
are compared in constant time and both fire the `rc_webhook_auth_total`
Prometheus counter (labelled `primary` / `secondary` / `invalid`), which
is how you verify each step landed.

## When to rotate

- Annual rotation hygiene.
- Anyone left the team who had eyes on `.config/secrets.env`.
- The RC dashboard recorded an unexpected webhook delivery (audit-trail tab).
- Suspected leak from any source — repo grep, log redaction miss, tracker.

## Pre-flight

- You have ssh access to the prod host and can run `./infra/.../deploy.sh`.
- You can edit the RC dashboard (Project → Webhooks).
- `.config/secrets.env` is up to date locally (`git pull`).
- The auth service has been redeployed since `feat/rc-bearer-hardening`
  landed — the dual-slot config is required for the procedure below.
  Confirm with `curl https://auth.shruti.app/metrics | grep rc_webhook_auth_total`;
  if the counter is absent, deploy first.

## Procedure

### 1. Generate the new secret

```bash
openssl rand -hex 32
```

Copy the output (a 64-char hex string). This becomes the new
`SECONDARY` value.

### 2. Stage the new secret as SECONDARY

Edit `.config/secrets.env`:

```bash
SHRUTI_RC_WEBHOOK_SECRET_PRIMARY=<existing-value>          # unchanged
SHRUTI_RC_WEBHOOK_SECRET_SECONDARY=<new-value-from-step-1>
```

Run the deploy:

```bash
./infra/app/deploy.sh
```

Auth comes back up with both slots live. Confirm via auth logs:

```
rc_webhook_enabled primary_set=true secondary_set=true
```

The existing RC dashboard still sends the old secret, so all live
traffic hits the `primary` label.

### 3. Flip the RC dashboard to the new secret

RC dashboard → Project → Integrations → Webhooks → edit the
production endpoint. Replace the `Authorization` header value with the
new secret from step 1. Save.

### 4. Verify SECONDARY is taking traffic

Prometheus / Grafana — query:

```promql
rate(rc_webhook_auth_total{key="secondary"}[5m])
```

You should see this start climbing within one minute (RC fires webhooks
on most subscription state changes; on a quiet day you can force one by
toggling a subscription on a test account). The `primary` counter should
plateau.

Also verify `rc_webhook_auth_total{key="invalid"}` is **not** climbing
— that would mean RC isn't actually picking up the new secret, or
something else is hitting the endpoint with a wrong token.

### 5. Promote SECONDARY → PRIMARY

Once you've confirmed the new secret is the one in active use (give it
at least 30 min of normal traffic to be safe), edit `.config/secrets.env`:

```bash
SHRUTI_RC_WEBHOOK_SECRET_PRIMARY=<value-that-was-secondary>
SHRUTI_RC_WEBHOOK_SECRET_SECONDARY=
```

Run the deploy once more:

```bash
./infra/app/deploy.sh
```

Auth boots with only `PRIMARY` set. `rc_webhook_auth_total{key="secondary"}`
stops climbing; `rc_webhook_auth_total{key="primary"}` now carries the
full webhook stream.

### 6. Cleanup

- Confirm the legacy `SHRUTI_RC_WEBHOOK_SECRET` env var is empty in
  `.config/secrets.env` (any value here would be promoted to PRIMARY at
  boot if both new slots ever go empty — surprising during a future
  rotation). Remove the line if it's there.
- If the rotation was triggered by a leak, also rotate the RC REST API
  key (`SHRUTI_RC_REST_API_KEY`) — same dashboard, different section.
  That key is not dual-slotted; rotation there is a hard cutover, do it
  in a low-traffic window.

## Troubleshooting

**`rc_webhook_auth_total{key="invalid"}` climbing after step 3.**
RC didn't actually pick up the new secret. Double-check the dashboard
saved the change (RC's UI sometimes shows the field as updated but
silently keeps the old value if the page wasn't fully reloaded). Worst
case revert step 3 — `primary` is still live, no deliveries are lost.

**Auth boots with `rc_webhook_disabled` after step 5.**
You cleared both slots and the legacy `SHRUTI_RC_WEBHOOK_SECRET` env
var is also empty, so the handler stays unwired. Set PRIMARY and redeploy.

**Deliveries pile up in RC's "unprocessed" queue.**
RC retries failed webhooks for ~80 min. The backfill cron
(`auth /internal/reconcile`) catches anything past that window, so a
brief auth outage during deploy is fine. If the queue is hours deep
something else is wrong — check auth logs for `rc_webhook_*` slog
events and the cleanup-worker for `cleanup_worker_outbox_stuck` alerts.

## See also

- `modules/services/auth/internal/handler/rc_webhook.go` — the handler.
- `modules/services/auth/internal/config/config.go` — env wiring.
- `infra/app/compose/docker-compose.yml` — env passthrough block on the
  `auth:` service.
