# infra/observability/

Self-hosted observability stack for Shruti, deployed onto a dedicated
VPS (12 GB RAM / 6 vCPU / 100 GB NVMe).

What ships in this directory:

- **Grafana 11.4** — UI, dashboards, unified alerting
- **Loki 3.3** — log aggregation (30-day retention)
- **Prometheus 2.55** — metrics (90-day retention)
- **Langfuse 3.55** — LLM tracing + prompt management (web + worker)
- **ClickHouse 24.10** — Langfuse event store, capped at 3 GB RAM
- **Postgres 16** — Langfuse metadata (separate from prod postgres)
- **Redis 7** — Langfuse worker queue
- **MinIO** — S3-compatible object store for Langfuse blob uploads
- **Caddy** — reverse proxy; wildcard TLS from Caddy's internal CA
  (`tls internal`)
- **node-exporter / cAdvisor / promtail** — self-monitoring for the obs
  host itself
- **blackbox exporter** — probes the regional edges and the storage
  mirror from this host (see [Edge and mirror probes](#edge-and-mirror-probes))

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
│   ├── blackbox.yml                        # edge + mirror probe modules
│   ├── probe-targets/                      # rendered at deploy (gitignored)
│   ├── loki-config.yaml
│   ├── promtail-self.yaml
│   ├── clickhouse/config.xml
│   └── grafana/provisioning/
│       ├── datasources/datasources.yml.template
│       ├── dashboards/{dashboards.yml,json/{1860,14282,9628,shruti-edges}.json}
│       └── alerting/{contact-points,policies,rules}.yml
├── config/
│   ├── eu.env                              # public per-region config
│   └── shared.env.example                  # copy → shared.env, fill secrets
├── scripts/
│   ├── deploy.sh                           # ./deploy.sh <obs-ip> [--region eu]
│   ├── configure.sh                        # ./configure.sh --region eu
│   └── lib/
│       ├── bootstrap-langfuse.sh
│       ├── bootstrap-grafana-contacts.sh
│       ├── render-probe-targets.sh
│       └── verify-stack.sh
├── secrets/                                # gitignored
└── README.md
```

## Quick start

```bash
# 1. Provision the VPS, get the root password from your provider, push your key.
ssh-copy-id root@<obs.public.ip>

# 2. Install Tailscale + bring up obs node (in the Tailscale admin
#    console create a reusable, pre-approved auth key with tag:shruti-obs):
ssh root@<obs.public.ip> "curl -fsSL https://tailscale.com/install.sh | sh && \
  tailscale up --authkey=tskey-... --advertise-tags=tag:shruti-obs"
ssh root@<obs.public.ip> 'tailscale ip -4'    # → 100.x.x.B

# 3. Fill in config/shared.env (copy from .example) and bump OBS_TS_IP +
#    PROD_HOST_TS_IP in config/eu.env.

# 4. Deploy:
./scripts/deploy.sh 100.x.x.B --region eu

# 5. One-time configure (DNS + Langfuse project + Grafana contacts):
./scripts/configure.sh --region eu

# 6. URLs (only reachable from inside the Tailnet):
#    https://grafana.<TAILNET_DOMAIN>
#    https://langfuse.<TAILNET_DOMAIN>
#    https://prometheus.<TAILNET_DOMAIN>
```

The deploy script is idempotent — re-run any time to push config /
template / dashboard changes. Secrets are generated once and reused on
subsequent runs (overwriting `ENCRYPTION_KEY` would destroy at-rest
data).

## Edge and mirror probes

A blackbox exporter on this host probes every regional edge (the `edge`
Caddy role, see `infra/app/README.md`) and the storage mirror's public
catalog manifest. Probing from here, not from origin, keeps the edges
visible when origin is down.

| Job | Target | What a failure means |
|---|---|---|
| `blackbox-edge-nodes`, `check="healthz"` | `https://<edge>/healthz` | The edge itself — host, Caddy, certificate, network path. |
| `blackbox-edge-nodes`, `check="api"` | `https://<edge>/healthz/api` | The edge → origin leg: the edge proxies origin's `/healthz`. |
| `blackbox-edge-nodes`, `check="cdn"` | `https://<edge>/healthz/cdn` | The edge → CDN leg: the edge proxies a probe object over 64 KiB, read in full. |
| `blackbox-mirror` | `SHRUTI_MIRROR_CONFIG_URL` | The mirror's `config.json` is not served as a JSON object. |
| `blackbox-reference` | `OPTIONS https://${SHRUTI_DOMAIN}/healthz`, answered `204` by origin's Caddy | This host cannot reach origin's Caddy — its own network, or origin's host. No app is involved. |

The two upstream checks are answered through the edge's own upstream
connections, so one request from here exercises both the edge and the leg
behind it; nothing runs on the edge for monitoring. The `http_edge` module
(`compose/blackbox.yml`) has a 10 s budget and reads the whole body, so a
CDN transfer that stalls after its first bytes fails by timeout instead of
hanging. Blackbox has no minimum body size, so the 64 KiB floor is in the
alert, on `probe_http_uncompressed_body_length`.

Alerts (`edge-nodes` group in `rules.yml`, routed like every other alert):

| Alert | Severity | Fires when |
|---|---|---|
| `edge_node_down` | P1 | under 75 % of `/healthz` probes passed over 5 min, for 2 min |
| `edge_node_api_leg_failing` | P1 | under 75 % of `/healthz/api` probes passed over 5 min, for 3 min, while the edge is up and origin is reachable from here |
| `edge_node_cdn_leg_failing` | P1 | under 75 % of `/healthz/cdn` probes passed with a body of at least 64 KiB over 5 min, for 3 min, while the edge is up |
| `edge_node_cdn_leg_slow` | P2 | `/healthz/cdn` averages over 4 s across 10 min, for 10 min, while the edge is up |
| `probe_reference_failing` | P2 | this host gets no answer from origin's Caddy (under 75 % over 5 min, for 3 min) |
| `probe_scrape_failing` | P2 | Prometheus cannot scrape this host's blackbox for a probe job |
| `mirror_config_unreachable` | P2 | the mirror manifest probe fails for 10 min |

Every edge rule reads a success ratio over a window, not the last probe: a
check failing two probes in three, or every other probe, pages; one failed
probe does not. The leg alerts only evaluate while the edge's own
`/healthz` ratio is at least 50 %. An edge below 50 % pages once, as
`edge_node_down`. An edge between 50 % and 75 % is checked on both counts:
`edge_node_down` and any failing leg alert can fire together, so an edge that
is up most of the time still has a dead leg paged.

The `blackbox-reference` job sends a preflight (`OPTIONS`) to origin's
`/healthz`, which origin's Caddy answers with `204` itself, so an app outage
on origin never moves it.
- Reference **and every edge's** `/healthz` failing together: this host's own
  network is down. All edge alerts hold off; `probe_reference_failing` pages.
- Reference failing while at least one edge is up: origin's host or Caddy
  is unreachable. Only the API-leg alerts hold off, since they fail because
  origin does; a dead edge still pages, and `edge_unhealthy` reports origin
  from its own side.

Limitation: the joint rule cannot tell an observer outage from origin going
down while **every** configured edge is down too — with a single edge (the
first deployment has one), that is origin and that edge down together. Then
all edge alerts hold off and `edge_node_down` stays quiet; `edge_unhealthy`
and `probe_reference_failing` still page.

`tls_cert_expiring_soon` pages once per certificate we operate — origin's and
each edge's, whichever checks saw it; the mirror is served under its
provider's certificate and is left out. With no edges configured there are
no series and nothing fires. The **Shruti — Edges and storage mirror** dashboard shows each check
per edge, probe durations, the CDN probe's body size, and storage-sync's
per-pass counters (`listed`, `heads`, `copied`, `failed`, `bytes`) from
its `sync_pass_done` / `sync_pass_failed` log lines.

### Adding or removing an edge

Edges are listed in `config/shared.env` (gitignored) as `host[:port]`,
separated by commas, spaces or newlines. Names are lowercased and repeats
dropped; each DNS label must be 1–63 characters and the port 1–65535:

```bash
SHRUTI_EDGE_HOSTS=edge-1.example.com,edge-2.example.com
SHRUTI_MIRROR_CONFIG_URL=https://mirror.example.com/public/config.json
```

Re-run `./scripts/deploy.sh`. It renders `compose/probe-targets/edges.json`
and `mirror.json`; Prometheus re-reads them without a restart. Either
variable may be unset or empty. An entry that is not a valid `host[:port]`,
or a mirror URL that is not `https://`, stops the deploy before anything is
copied to the host.

## Langfuse data retention

Every Langfuse ClickHouse table (`traces`, `observations`, `scores`,
`event_log`) carries a 90-day TTL, applied on each `configure.sh` run by
`scripts/lib/bootstrap-langfuse-ttl.sh`:

```sql
ALTER TABLE langfuse.<table>
  MODIFY TTL toDateTime(<timestamp_col>) + INTERVAL 90 DAY DELETE;
```

Timestamp columns are `timestamp` (traces, scores), `start_time`
(observations) and `created_at` (event_log). Re-running the script is a
metadata-only no-op once the TTL is in place.

This is the corpus-wide safety-net retention policy. It complements the
per-user purge issued through the Langfuse API when an account is
deleted: even if that best-effort call fails or pre-dates a user, every
trace row tied to a deleted user disappears within 90 days. It also caps
ClickHouse disk growth on the 100 GB VPS — without it the only bound on
trace volume is operator intervention. To change the window, bump
`LANGFUSE_TTL_DAYS` in `bootstrap-langfuse-ttl.sh` and re-run
`./scripts/configure.sh --region <r>`.

Note: Langfuse OSS project-level retention is enterprise-only; the
ClickHouse-native TTL above is the supported lever for self-hosted.

## Troubleshooting

**Langfuse won't start, healthcheck times out.**
ClickHouse migrations take 60–120s on cold boot. The compose healthcheck
has `start_period: 180s`. If it's still failing after 4 minutes:
```bash
ssh obs 'docker compose -f /opt/shruti-observability/compose/docker-compose.yml logs langfuse-web | tail -100'
```
Common cause: `ENCRYPTION_KEY` not exactly 32 hex bytes — regenerate the
file (`rm secrets/encryption_key` then re-run deploy) **only on a first
deploy where Langfuse hasn't ingested any data yet**.

**Browser rejects the UI certificate.**
Caddy issues the wildcard certificate from its internal CA. Trust that CA
on the client once; its root is in the `caddy-data` volume under
`caddy/pki/authorities/local/root.crt`.

**Grafana shows datasource error / Loki "no such datasource".**
The datasources file is rendered from `datasources.yml.template`. If
`TAILNET_DOMAIN` was empty when `deploy.sh` ran, the rendered file is
broken. Re-export the var and re-run deploy.

**No alerts on Telegram.**
1. `curl -s "https://api.telegram.org/bot${TG_BOT_TOKEN}/getMe"` — bot token valid?
2. In Grafana → Alerting → Contact points → telegram-main → "Test".
3. Verify `chat_id` is **negative** if it's a group (positive for direct chats).

## Adding a region

```bash
cat > config/<region>.env <<EOF
REGION=<region>
TAILNET_DOMAIN=obs.<region>.example.com
OBS_TS_IP=100.x.x.X
PROD_HOST_TS_IP=100.x.x.Y
LANGFUSE_INIT_USER_EMAIL=admin@example.com
LANGFUSE_INIT_USER_NAME=admin
EOF

./scripts/deploy.sh 100.x.x.X --region <region>
./scripts/configure.sh --region <region>
```

No script changes needed.
