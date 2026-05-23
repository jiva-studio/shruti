# observability-agent

Lightweight collectors that run **on the prod-EU host**, sitting next to the
chat / auth / share-* stack (`infra/compose/` — to be renamed `infra/app/`
by Stream A). They push logs to the obs host's Loki and expose metrics
endpoints for the obs host's Prometheus to scrape.

This is **not** the observability stack itself. The Grafana / Loki /
Prometheus / Langfuse stack lives on a separate VPS — see (Stream A's)
`infra/observability/` once that lands.

## What runs here

| Container | Image | Bind | Purpose |
|---|---|---|---|
| `lectorium-promtail` | `grafana/promtail:3.3.0` | `${PROD_EU_TS_IP}:9080` (self-metrics) | Tails Docker JSON log files, pushes to Loki on obs. |
| `lectorium-node-exporter` | `prom/node-exporter:v1.8.2` | `${PROD_EU_TS_IP}:9100` | Host CPU / RAM / disk / net (network_mode: host). |
| `lectorium-cadvisor` | `gcr.io/cadvisor/cadvisor:v0.49.1` | `${PROD_EU_TS_IP}:8090` | Per-container metrics (port 8090, NOT 8080). |
| `lectorium-postgres-exporter` | `quay.io/prometheuscommunity/postgres-exporter:v0.16.0` | `${PROD_EU_TS_IP}:9187` | Postgres metrics + custom queries (`share_video_queue_depth`, `oldest_pending_seconds`). |
| `lectorium-redis-exporter` | `oliver006/redis_exporter:v1.66.0` | `${PROD_EU_TS_IP}:9121` | Redis hit-rate, memory, evictions. |
| `lectorium-blackbox-exporter` | `prom/blackbox-exporter:v0.25.0` | `${PROD_EU_TS_IP}:9115` | HTTP `/healthz` probes for chat/auth/share-*, TLS expiry check for `*.obs.eu.lectorium.akdasa.studio`. |

All exporters bind on the Tailscale IP — they're invisible from the public
Cloud Provider interface. Watchtower is told not to auto-update these
(`com.centurylinklabs.watchtower.enable=false`); image bumps are manual via
`./scripts/deploy.sh`.

## Prereqs on the host

1. **chat-stack docker network must exist** — `lectorium_lectorium`.
   `postgres-exporter`, `redis-exporter`, and `blackbox-exporter` attach to
   it as an `external` network. If `infra/app/` (or current `infra/compose/`)
   isn't deployed first, `deploy.sh` aborts with a clear error.

2. **Postgres `lectorium_exporter` role must exist** — see "Postgres bootstrap"
   below.

3. **Tailscale must be up** on the host with `tag:lectorium-prod-eu`. The agent
   doesn't manage Tailscale; that's part of `infra/app/` host bootstrap
   in Stream A.

4. **Docker daemon log rotation** must be set on the host
   (`/etc/docker/daemon.json` with `max-size: 50m, max-file: 5`).
   Without it, Promtail will be reading from an unbounded `/var/lib/docker/`
   that fills disk in 2–3 months.

## Postgres bootstrap

`postgres-exporter` connects as the role `lectorium_exporter` with `pg_monitor`.
There are two paths to create this role + `pg_stat_statements` extension,
depending on whether the prod Postgres volume already exists.

### (a) Fresh prod volume — first deploy of chat-stack

The seed file `infra/app/compose/postgres/init.sql` is mounted into
`/docker-entrypoint-initdb.d/` and executed by the pgvector image **only
on an empty volume**. It runs:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE USER pg_exporter WITH PASSWORD '__REPLACE_AT_DEPLOY__';
GRANT pg_monitor TO pg_exporter;
```

`infra/app/scripts/deploy.sh` is expected to template the placeholder
with the real `PG_EXPORTER_PASSWORD` before the container starts (Stream A
work). The same value must be present in this agent's `.env` so both
sides agree.

### (b) Existing prod volume — retrofitting (the realistic case)

Init scripts in `/docker-entrypoint-initdb.d/` **do not run** on a
non-empty Postgres volume. To create the role on the live database, exec
the SQL manually with a ~30 s planned-downtime window for the
`shared_preload_libraries` ALTER + restart:

```bash
# Replace <PASSWORD> with the value you'll put in observability-agent/.env.
ssh prod-eu '
  docker exec -i lectorium-postgres-1 psql -U lectorium -d lectorium <<SQL
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    DO \$\$ BEGIN
      CREATE ROLE pg_exporter LOGIN PASSWORD '"'"'<PASSWORD>'"'"';
    EXCEPTION WHEN duplicate_object THEN
      ALTER ROLE pg_exporter WITH PASSWORD '"'"'<PASSWORD>'"'"';
    END \$\$;
    GRANT pg_monitor TO pg_exporter;
    ALTER SYSTEM SET shared_preload_libraries = '"'"'pg_stat_statements'"'"';
  SQL
  cd /opt/lectorium && docker compose restart postgres
'
```

Verify:

```bash
ssh prod-eu 'docker exec -i lectorium-postgres-1 psql -U lectorium -d lectorium -c "\du pg_exporter"'
```

Note: the container name above (`lectorium-postgres-1`) assumes the
compose project name `lectorium` (it is — see
`infra/compose/docker-compose.yml`, top-level `name: lectorium`).

## Deploy

```bash
cd infra/observability-agent
cp .env.example .env
# Fill in PROD_EU_TS_IP, OBS_TS_IP, PG_EXPORTER_PASSWORD.

SERVER_IP=<prod-eu-public-ip> \
PROD_EU_TS_IP=100.x.x.A \
OBS_TS_IP=100.x.x.B \
PG_EXPORTER_PASSWORD=<same as Postgres bootstrap above> \
  ./scripts/deploy.sh
```

If the host is already prepared by `infra/app/scripts/deploy.sh` (docker,
compose plugin, tailscale present), pass `SKIP_BOOTSTRAP=1` to skip the
apt-install steps:

```bash
SKIP_BOOTSTRAP=1 SERVER_IP=… ./scripts/deploy.sh
```

After deploy, exporter endpoints are reachable from the obs host via the
Tailnet:

```
http://${PROD_EU_TS_IP}:9100/metrics    # node-exporter
http://${PROD_EU_TS_IP}:8090/metrics    # cadvisor
http://${PROD_EU_TS_IP}:9187/metrics    # postgres-exporter
http://${PROD_EU_TS_IP}:9121/metrics    # redis-exporter
http://${PROD_EU_TS_IP}:9115/metrics    # blackbox-exporter (self-metrics)
http://${PROD_EU_TS_IP}:9080/metrics    # promtail self-metrics
```

The obs host's Prometheus scrape config (Stream A's
`infra/observability/compose/prometheus.yml`) targets these URLs.

## Blackbox probe targets

Configured **on the Prometheus side**, not here — that way you can add a
new probe without redeploying the agent. The agent only declares the
*modules* (`http_2xx`, `tcp_connect`, `tls_connect`, …) — see
`compose/blackbox-config.yaml`.

Expected probe targets in Prometheus on obs:

| Target | Module | Notes |
|---|---|---|
| `http://chat:8080/healthz` | `http_2xx` | chat-stack network DNS — works because blackbox is on `lectorium_lectorium`. |
| `http://auth:8081/healthz` | `http_2xx` | |
| `http://share-audio:8082/healthz` | `http_2xx` | |
| `http://share-video:8083/healthz` | `http_2xx` | |
| `grafana.obs.eu.lectorium.akdasa.studio:443` | `tls_connect` | Cert expiry — alert at <14 days remaining. |

## Custom Postgres queries

See `compose/postgres-queries.yaml`. Currently:

- `lectorium_share_video_queue_depth` — `count(*) FROM tasks WHERE state='pending'`
- `lectorium_share_video_oldest_pending_seconds` — oldest pending task age
- `lectorium_share_video_tasks_by_state{state=...}` — distribution

Add more by extending that file and re-running `./scripts/deploy.sh`
(rsync replaces the config, `docker compose up -d` rolls the container).

## Tearing down

```bash
ssh prod-eu 'cd /opt/lectorium-obs-agent/compose && docker compose --env-file ../.env down'
```

This is **independent of the chat-stack** — `compose down` here doesn't
touch chat/auth/share-*/postgres/redis.
