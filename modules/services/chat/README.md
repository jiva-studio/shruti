# Shruti chat backend

Semantic chat over Shruti lecture transcripts. Python service deployed on a
Cloud Provider VPS via docker-compose. HTTPS via Caddy + sslip.io (auto Let's Encrypt
cert, no domain purchase needed). Periodically pulls the catalog DB and
reviewed transcripts from S3, embeds chunks into pgvector via OpenAI
text-embedding-3-small through OpenRouter, exposes `/chat` with an LLM agent.

## Local dev

```bash
cd modules/services/chat
cp .env.example .env
# fill: AWS_*, OPENROUTER_API_KEY, APP_SHARED_TOKEN

docker compose -f compose/docker-compose.dev.yml up --build
# wait for service_ready (~few seconds)
# indexer chews the corpus in the background

curl -fsS -N -X POST http://localhost:8080/chat \
  -H "X-Device-Id: test-001" \
  -H "X-App-Token: dev-token" \
  -H "Accept: text/event-stream" \
  -d '{"messages":[{"role":"user","content":"что Прабхупада говорил про варнашраму?"}],"lang":"ru"}'
```

## Production deploy (Cloud Provider)

### One-time: provision the VPS

In Cloud Provider's panel <https://my.contabo.com>:

1. **Cloud VPS** → **Cloud VPS 10** (or higher) — 4 vCPU, 8 GB RAM, 75 GB NVMe — **€3.60/mo**
2. **Region**: Düsseldorf / Nuremberg (EU, low-latency to S3)
3. **Image**: Ubuntu 24.04
4. **SSH key**: upload `~/.ssh/id_ed25519.pub` (Cloud Provider emails a root password too)
5. Create. After ~2 minutes you get a public IPv4.

### Deploy

```bash
SERVER_IP=YOUR.IP.HERE ./scripts/deploy.sh
```

`deploy.sh`:
- Waits for SSH on the IP
- Installs docker + compose plugin if missing (via cloud-init or apt)
- Generates a strong `POSTGRES_PASSWORD` on the server (one-shot, persisted in `/opt/shruti-chat/.pg_password`)
- Auto-derives `DOMAIN` = `<ip-dashed>.sslip.io`
- rsync's code + `.env` (with prod values injected)
- `docker compose up -d --build`
- Waits for `/healthz` over HTTPS (Caddy issues LE cert on first run, ~60s)
- Prints `/readyz` and `/status`

### Redeploy after code changes

```bash
SERVER_IP=YOUR.IP.HERE ./scripts/deploy.sh
```

Idempotent. Reuses the existing Postgres password, only rebuilds the chat
container; postgres + caddy keep running.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /chat` | `X-App-Token` + `X-Device-Id` | SSE stream of agent response |
| `POST /reindex` | `X-App-Token` | Force indexer run |
| `GET /healthz` | — | Liveness |
| `GET /readyz` | — | Readiness (db + embedder + catalog) |
| `GET /status` | `X-App-Token` | Detailed runtime status |
| `GET /version` | — | Build info |

## Cost

| Item | Price |
|---|---|
| Cloud Provider Cloud VPS 10 (4 vCPU, 8 GB, 75 GB NVMe) | €3.60/mo (12-month) or €4.50/mo (monthly) |
| OpenRouter (embeddings + chat, ~50 users × 3 req/day) | ~$2–5/mo |
| **Total** | **~€6/mo** |

## Configuration

All knobs are env vars; see `.env.example`. Provider abstractions:
- LLM: `LLM_DEFAULT=openrouter/...` (LiteLLM model id). GigaChat / YandexGPT /
  Anthropic / OpenAI scaffolded but inactive.
- Embedder: `EMBED_PROVIDER=openrouter` (text-embedding-3-small, 1536d).
  Yandex / GigaChat wired but inactive.

Switching embedder = full reindex. `chunks.embed_model` tracks the producer;
indexer detects mismatch and re-embeds.

## Layout

```
agent/
├── Dockerfile                       # python:3.12-slim, no torch
├── compose/
│   ├── docker-compose.yml           # prod: postgres + chat + caddy
│   ├── docker-compose.dev.yml       # dev: postgres + chat (no caddy)
│   └── caddy/Caddyfile              # auto-TLS via sslip.io
├── app/                             # FastAPI app + indexer + agent
└── scripts/
    ├── deploy.sh                    # rsync + ssh + compose up + probes
    └── smoke_chunker.py             # local chunker sanity check
```
