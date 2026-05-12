# transcriber-mcp

MCP server that exposes the transcription pipeline (`transcriber-service`) as typed tools for an LLM agent — primarily Claude Code on a remote machine.

## How the pieces fit

```
remote Claude Code ── MCP/streamable-HTTP or SSE ──► transcriber-mcp :8090
                                                     │
                                                     ▼ localhost HTTP
                                                  transcriber-service :8080
                                                     │
                                                     ▼ stdin / stderr
                                                  fluidbatchd (Apple ANE)
```

**Audio bytes never go through MCP.** The agent uses its Bash tool to `curl` the file directly to `transcriber-service`'s REST endpoint, gets back a `job_id`, and then calls MCP tools with that small string argument. This avoids burning ~3M context tokens on inline base64 for every 8 MB lecture.

The MCP server itself is tiny (~150 LoC + tests) and stateless — a thin wrapper around the [REST API](../transcriber-service/docs/API.md).

## Tools

| Tool | Description |
|---|---|
| `transcribe_wait` | Long-poll for a job to reach `done`/`failed`. Returns text + key metrics (no per-word timings — those are bulky). `timeout_s=0` peeks at current status without blocking. |
| `get_transcript` | Fetch the full transcript JSON including `wordTimings`. Use after a `done` is reported. |
| `list_jobs` | Browse the queue, filter by status. |
| `get_service_url` | Show which `transcriber-service` URL the MCP server is currently talking to. |
| `set_service_url` | Re-point the MCP server at a different `transcriber-service` at runtime. In-flight `transcribe_wait` calls finish against the previous URL; new calls observe the swap. Useful for testing or fail-over without restarting the MCP server. |

What's deliberately **not** here: `delete_job`, `get_job`, `transcribe_inline`. Bash+curl covers deletion, `transcribe_wait(timeout_s=0)` replaces a polling-only "get_job", and inline-base64 upload is intentionally absent (see above).

## Build & run

```sh
# in this directory
make build              # builds bin/transcriber-mcp
make run                # foreground, Ctrl-C for graceful shutdown
```

Or from the parent (`Source/modules/tools/`) start both services together:

```sh
make transcriber-up     # backgrounds service + mcp, logs in /tmp/
make transcriber-status # quick health check
make transcriber-down
```

### Flags

| Flag | Default | Notes |
|---|---|---|
| `-addr` | `0.0.0.0:8090` | LAN binding by default. |
| `-service-url` | `http://localhost:8080` | Where transcriber-service lives. |
| `-poll-interval-fast` | `2s` | Polling cadence inside `transcribe_wait` for the first 60s. |
| `-poll-interval-slow` | `5s` | Cadence after the fast window. |
| `-poll-fast-window` | `60s` | When to switch from fast to slow. |
| `-max-timeout` | `1h` | Upper bound for client-supplied `timeout_s`. |
| `-heartbeat-interval` | `15s` | Keepalive frame frequency for streamable-HTTP and SSE. |
| `-token` | _empty_ | If set, requests must carry `Authorization: Bearer <token>`. Default off (homelab LAN). |

## Claude Code config

Add to your `.mcp.json` on the remote machine:

```json
{
  "mcpServers": {
    "transcriber": {
      "transport": {
        "type": "streamable-http",
        "url": "http://m4.local:8090/mcp"
      }
    }
  }
}
```

Or, for clients that don't yet speak streamable-HTTP, the same server also exposes SSE on `:8090/sse`:

```json
{
  "mcpServers": {
    "transcriber": {
      "transport": { "type": "sse", "url": "http://m4.local:8090/sse" }
    }
  }
}
```

## Workflow from the agent's POV

```
user: "Transcribe ~/audio/lecture.mp3"

agent (Bash):  curl -F file=@~/audio/lecture.mp3 -F language=ru \
                    http://m4.local:8080/jobs
            → {"job_id":"abc-123","status":"queued"}

agent (MCP):   transcribe_wait(job_id="abc-123")
            → {"status":"done","text":"Лекция по...","confidence":0.94}

agent: "Транскрипт готов: ..."
```

If the agent needs per-word timings (e.g. for subtitles), it follows up with `get_transcript(job_id="abc-123")`.

### Big files (>100 MB)

Claude Code's Bash tool defaults to a 2-minute timeout. For uploads that may take longer (large files over slow Wi-Fi, or hundreds of MB), pass an explicit longer timeout to the Bash call (e.g. `timeout: 600000` for 10 min) — otherwise curl gets killed mid-upload.

## Operational notes

- **Long-poll connections.** `transcribe_wait` can hold an HTTP connection open for up to `-max-timeout`. The server sends keepalive frames every `-heartbeat-interval` (default 15s). If you put any reverse proxy / VPN between the agent and the M4, make sure it doesn't break idle SSE/HTTP-streaming connections after a few minutes — direct LAN is the path of least pain.
- **Restart resilience.** Restarting `transcriber-mcp` aborts any in-flight `transcribe_wait` calls — clients should retry with the same `job_id`. The job state itself lives in `transcriber-service`, so nothing is lost.
- **Upstream health.** `transcriber-mcp` probes `transcriber-service`'s `/healthz` at startup (every 5s for 30s), then every 30s thereafter. Its own `/healthz` reports `upstream_ok=false` when the service is unreachable — useful for alerting / readiness checks.

## Documentation

- REST surface (curl examples + per-endpoint schemas): [`../transcriber-service/docs/API.md`](../transcriber-service/docs/API.md).
- Why we run Parakeet on ANE and not Whisper: [`../transcriber-service/fluidbatchd/README.md`](../transcriber-service/fluidbatchd/README.md).
