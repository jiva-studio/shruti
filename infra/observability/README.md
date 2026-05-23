# infra/observability/

Self-hosted observability stack for Lectorium. Deployed onto a dedicated
Cloud Provider Cloud VPS 20 (12 GB RAM / 6 vCPU / 100 GB NVMe, ~€5.60 / month).

What ships in this directory:

- **Grafana 11.4** — UI, dashboards, unified alerting
- **Loki 3.3** — log aggregation (30-day retention)
- **Prometheus 2.55** — metrics (90-day retention)
- **Langfuse 3.55** — LLM tracing + prompt management (web + worker)
- **ClickHouse 24.10** — Langfuse event store, capped at 3 GB RAM
- **Postgres 16** — Langfuse metadata (separate from prod postgres)
- **Redis 7** — Langfuse worker queue
- **MinIO** — S3-compatible object store for Langfuse blob uploads
- **Caddy** (`caddy-cloudflare:2.8.4`) — reverse proxy + wildcard TLS via
  Cloudflare DNS-01
- **node-exporter / cAdvisor / promtail** — self-monitoring for the obs
  host itself

## Network model

```
obs (Tailscale 100.x.x.B)
├── Caddy binds   100.x.x.B:443,80   ← reverse proxy for all UIs
├── Langfuse push 100.x.x.B:3001     ← chat SDK on prod-EU sends traces here
└── Loki ingest   100.x.x.B:3100     ← promtail on prod-EU pushes logs here
```

Everything else is on the docker bridge network and never reaches the
public NIC. ufw policy (`infra/shared/templates/ufw-rules.sh`) is
default-deny on the public interface, allow-all on `tailscale0`.

## Layout

```
observability/
├── compose/
│   ├── docker-compose.yml                  # pinned versions
│   ├── Caddyfile.template                  # → Caddyfile (envsubst at deploy)
│   ├── prometheus.yml.template             # → prometheus.yml
│   ├── loki-config.yaml
│   ├── promtail-self.yaml
│   ├── clickhouse/config.xml
│   └── grafana/provisioning/
│       ├── datasources/datasources.yml.template
│       ├── dashboards/{dashboards.yml,json/{1860,14282,9628}.json}
│       └── alerting/{contact-points,policies,rules}.yml
├── config/
│   ├── eu.env                              # public per-region config
│   └── shared.env.example                  # copy → shared.env, fill secrets
├── scripts/
│   ├── deploy.sh                           # ./deploy.sh <obs-ip> [--region eu]
│   ├── configure.sh                        # ./configure.sh --region eu
│   └── lib/
│       ├── bootstrap-cloudflare-dns.sh
│       ├── bootstrap-langfuse.sh
│       ├── bootstrap-grafana-contacts.sh
│       └── verify-stack.sh
├── secrets/                                # gitignored
└── README.md
```

## Quick start

```bash
# 1. Provision a Cloud Provider VPS 20, get root password by email, push your key.
ssh-copy-id root@<obs.public.ip>

# 2. Install Tailscale + bring up obs node (in the Tailscale admin
#    console create a reusable, pre-approved auth key with tag:lectorium-obs):
ssh root@<obs.public.ip> "curl -fsSL https://tailscale.com/install.sh | sh && \
  tailscale up --authkey=tskey-... --advertise-tags=tag:lectorium-obs"
ssh root@<obs.public.ip> 'tailscale ip -4'    # → 100.x.x.B

# 3. Fill in config/shared.env (copy from .example) and bump OBS_TS_IP +
#    PROD_HOST_TS_IP in config/eu.env.

# 4. Deploy:
./scripts/deploy.sh 100.x.x.B --region eu

# 5. One-time configure (DNS + Langfuse project + Grafana contacts):
./scripts/configure.sh --region eu

# 6. URLs (only reachable from inside the Tailnet):
#    https://grafana.obs.eu.lectorium.akdasa.studio
#    https://langfuse.obs.eu.lectorium.akdasa.studio
#    https://prometheus.obs.eu.lectorium.akdasa.studio
```

The deploy script is idempotent — re-run any time to push config /
template / dashboard changes. Secrets are generated once and reused on
subsequent runs (overwriting `ENCRYPTION_KEY` would destroy at-rest
data).

## Troubleshooting

**Langfuse won't start, healthcheck times out.**
ClickHouse migrations take 60–120s on cold boot. The compose healthcheck
has `start_period: 180s`. If it's still failing after 4 minutes:
```bash
ssh obs 'docker compose -f /opt/lectorium-observability/compose/docker-compose.yml logs langfuse-web | tail -100'
```
Common cause: `ENCRYPTION_KEY` not exactly 32 hex bytes — regenerate the
file (`rm secrets/encryption_key` then re-run deploy) **only on a first
deploy where Langfuse hasn't ingested any data yet**.

**Caddy stuck on ACME challenge.**
```bash
ssh obs 'docker compose -f .../docker-compose.yml logs caddy | grep -i acme'
```
Check that `CF_API_TOKEN` has `Zone:DNS:Edit` scope on `akdasa.studio`.
The token from `https://dash.cloudflare.com/profile/api-tokens` must be
the one in `config/shared.env`.

**Grafana shows datasource error / Loki "no such datasource".**
The datasources file is rendered from `datasources.yml.template`. If
`TAILNET_DOMAIN` was empty when `deploy.sh` ran, the rendered file is
broken. Re-export the var and re-run deploy.

**No alerts on Telegram.**
1. `curl -s "https://api.telegram.org/bot${TG_BOT_TOKEN}/getMe"` — bot token valid?
2. In Grafana → Alerting → Contact points → telegram-main → "Test".
3. Verify `chat_id` is **negative** if it's a group (positive for direct chats).

See `/home/akd/.claude/plans/distributed-stirring-riddle.md` →
*"Run-book"* + *"Debug сценарии"* for more.

## Adding a region (RU example)

```bash
cat > config/ru.env <<EOF
REGION=ru
TAILNET_DOMAIN=obs.ru.lectorium.akdasa.studio
OBS_TS_IP=100.x.x.X
PROD_HOST_TS_IP=100.x.x.Y
LANGFUSE_INIT_USER_EMAIL=admin@akdasa.studio
LANGFUSE_INIT_USER_NAME=admin
EOF

./scripts/deploy.sh 100.x.x.X --region ru
./scripts/configure.sh --region ru
```

No script changes needed.
