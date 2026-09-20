# Shruti chat backend

Semantic chat over Shruti lecture transcripts. Python service deployed on a
VPS as one of several shruti services behind a shared `infra/` stack
(Postgres + Caddy + chat + auth). Periodically pulls the catalog DB and
reviewed transcripts from S3, embeds chunks into pgvector via OpenAI
text-embedding-3-small through OpenRouter, exposes `/chat` with an LLM agent.

## Local dev

Whole stack (postgres + chat) via the workspace-level dev compose:

```bash
cp infra/.env.example infra/.env.dev
# fill: AWS_*, OPENROUTER_API_KEY, APP_SHARED_TOKEN (admin endpoints only)

docker compose \
  -f infra/app/compose/docker-compose.yml \
  -f infra/app/compose/docker-compose.dev.yml \
  up --build
# wait for service_ready (~few seconds)
# indexer chews the corpus in the background

# User endpoints take a JWT (issued by /auth/anonymous or /auth/signin).
curl -fsS -N -X POST http://localhost:8080/chat \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: text/event-stream" \
  -H "X-Chat-Protocol-Version: 1" \
  -d '{"messages":[{"role":"user","content":"что Прабхупада говорил про варнашраму?"}],"lang":"ru"}'
```

## Dependencies

`app/uv.lock` is the source of truth for every version. The image
(`Dockerfile`) installs with `uv sync --frozen`; CI installs the same lock
with `uv sync --locked`, so the tree CI proves green is the tree that ships
and rebuilding a commit reproduces its dependencies.

Editing `app/pyproject.toml` therefore requires re-locking, or `--locked`
fails CI:

```bash
cd modules/services/chat/app
uv lock              # or: uv lock --upgrade-package langfuse
uv sync --extra dev  # local venv, Python 3.12 per .python-version
uv run python -m pytest tests -q
```

## Tests, coverage and lint

The three lanes CI runs (`.github/workflows/services-chat-tests.yml`), from
`app/`:

```bash
uv run python -m pytest tests -q                         # suite
uv run python -m pytest tests -q --cov --cov-report=json # + coverage
uv run python scripts/check_coverage_floors.py           # per-package floors
ruff check .                                             # gating lint rules
```

Coverage is gated by a floor **per package**, not one number for the service:
the whole-service figure was a healthy 76.7% while individual packages sat near
zero, because a large well-tested package pays for a small untested one. The
floors live in `pyproject.toml` under `[tool.coverage_floors]`, each set just
below its measured value, and are meant to ratchet upward — a failure means
"add a test", never "lower the floor".

`ruff check` gates on the rules pinned in `[tool.ruff.lint]` (pyflakes + E9)
and is green. The wider rule set still has ~540 findings; the ruff lane counts
them in an advisory step so they can be paid down and promoted rule by rule.
Lint runs its own pinned ruff rather than the locked tree, so it answers in
seconds and a ruff release cannot turn the lane red on its own.

Tests that need real infrastructure are marked `needs_db` / `needs_network` and
skipped unless `--integration` or `SHRUTI_INTEGRATION_DB` is set. The
marker is what gates them, not the directory they live in.

## Production deploy

Deployment is workspace-level — see `infra/README.md`. One command brings
up Postgres + chat + auth + Caddy on the target VPS:

```bash
SERVER_IP=YOUR.IP.HERE ./infra/app/scripts/deploy.sh
```

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /chat` | Bearer JWT | SSE stream of agent response |
| `POST /title` | Bearer JWT | One-shot session title |
| `POST /questions` | Bearer JWT | Suggested follow-up chips |
| `POST /chat/feedback` | Bearer JWT | Thumbs-up/down on a turn |
| `POST /reindex` | `X-App-Token` (admin) | Force indexer run |
| `GET /status` | `X-App-Token` (admin) | Detailed runtime status |
| `GET /healthz` | — | Liveness |
| `GET /readyz` | — | Readiness (db + embedder + catalog) |
| `GET /version` | — | Build info |

JWT comes from the auth service — `/auth/anonymous` for device-bound
guest sessions, `/auth/signin` for Google/Apple sign-in. `X-App-Token`
is a separate operator-only shared secret for `/status` + `/reindex`;
user endpoints don't take it.

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
modules/services/chat/
├── Dockerfile                       # python:3.12-slim, no torch
├── app/                             # FastAPI app + indexer + agent
└── scripts/
    └── smoke_chunker.py             # local chunker sanity check
```

Compose, Caddy, and deploy live under workspace `infra/` (shared by all
services). See `infra/README.md`.
