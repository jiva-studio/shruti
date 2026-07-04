# shruti-corpus-mcp

Public, **read-only** MCP server over the Shruti scripture + lecture corpus.
Tools surface as `mcp__shruti-corpus-mcp__*`. It reads existing data only —
no writes, no auth, no new store.

- **Contract:** [`resources/corpus-mcp-api.md`](../../../../resources/corpus-mcp-api.md) (authoritative I/O).
- **Design:** [`resources/corpus-mcp-design.md`](../../../../resources/corpus-mcp-design.md).

It replaces `search-mcp`: it absorbs that service's `search`/`embed`/`pgvector`
code and reproduces its `search`/`search_get`/`search_window` behaviour as the
unified `search` (with a `title` type), `verse_get`/`document_get`, and
`transcript_window`.

## Data sources

| Source | Access | Backs |
|---|---|---|
| Postgres + pgvector (`chunks` + `chunk_embeddings_d1536`) | `pgx`, read-only | `search`, `transcript_window` |
| `library.db` (SQLite artifact) | `modernc.org/sqlite`, read-only | `verse.*`, `document.*`, source stats |
| `current.db` catalog (SQLite artifact) | `modernc.org/sqlite`, read-only | source/author/location dicts, reference resolution, `track.*` |
| Embedding API (OpenAI-compatible) | outbound HTTP | embed the `search` / `*.resolve` query |

The SQLite driver is **pure Go** (`modernc.org/sqlite`, no CGO) so the release
image stays a static `scratch` container. Both SQLite files are opened
read-only and are **self-bootstrapped from the Bunny CDN** (a Go port of chat's
indexer): read `${MEDIA_BASE_URL}/public/config.json`, download the latest
catalog (`public/db/shruti.{v}.db`) and library (`public/library/library.{v}.db`),
verify the SQLite header, atomic `os.Rename` swap into `CATALOG_DIR`, and
refresh on boot + on a periodic ticker.

## Tools (15)

`search` · `source_get`/`.list`/`.resolve` · `author_list`/`.resolve` ·
`location_list`/`.resolve` · `verse_get`/`.list` · `document_get`/`.list` ·
`track_get`/`.list` · `transcript_window`.

Response envelope (trimmed, read-only — no async `run`):

```jsonc
{ "ok": true,  "kind": "<tool>", "result": { … } }
{ "ok": false, "kind": "<tool>", "error": { "code", "message", "details" } }
```

Codes: `invalid_argument` · `not_found` · `dependency_failed` · `internal`.

References are addressed as `"BG 2.13"` / `"ШБ 5.5.3"` / `"CC Madhya 8.128"`
(Cyrillic ↔ Latin book codes both resolve). A track's public page is derived:
`https://shruti.app/{locale}/app/{slug}`.

## Configuration (env)

| var | default | purpose |
|---|---|---|
| `CORPUS_MCP_ADDR` | `0.0.0.0:8087` | listen address |
| `DATABASE_URL` | — | Postgres/pgvector DSN (optional; `search` + `transcript_window` disabled if empty) |
| `EMBED_PROVIDER` | `openrouter` | `openrouter` \| `openai` |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | must match the indexed corpus |
| `EMBED_DIM` | `1536` | selects `chunk_embeddings_d<dim>` |
| `EMBED_QUERY_PREFIX` | — | for e5-family models |
| `EMBED_BASE_URL` | — | override the OpenAI-compatible upstream |
| `OPENROUTER_API_KEY` / `OPENAI_API_KEY` | — | embedding credential |
| `MEDIA_BASE_URL` | — | Bunny pull-zone base for the SQLite self-bootstrap (if empty, uses on-disk files as-is) |
| `CATALOG_DIR` | `/var/lib/corpus-mcp` | writable dir for the downloaded SQLite artifacts |
| `LIBRARY_DB_PATH` | `${CATALOG_DIR}/library.db` | library SQLite path |
| `CATALOG_DB_PATH` | `${CATALOG_DIR}/current.db` | catalog SQLite path |
| `CORPUS_REFRESH_INTERVAL` | `15m` | artifact re-check cadence |

Postgres/embedding are optional: with them absent the SQLite-backed read tools
still serve, and `search`/`transcript_window` return `dependency_failed`. For
local dev, point `LIBRARY_DB_PATH`/`CATALOG_DB_PATH` at existing artifacts and
leave `MEDIA_BASE_URL` empty.

## Transport & ops

- Streamable-HTTP `/mcp` + SSE `/sse` (+ `/message`), **stateless**, binds
  `0.0.0.0:<port>`. Permissive CORS for browser MCP clients (claude.ai connector).
- `/healthz` returns `{status, build_sha, build_time}`; `-healthcheck` self-probes
  it (scratch image has no curl).
- **Query logging:** every tool call emits one JSON line to stdout
  (`{tool, query, filters, types, count, lang, latency_ms, ts, client_hash}` —
  `client_hash` is a hash of the client, never a raw IP) → docker json-file →
  promtail → Loki.

## Build & run

```sh
go build ./cmd/corpus-mcp
# local dev against the lake artifacts, no Postgres:
CATALOG_DB_PATH=…/current.db LIBRARY_DB_PATH=…/library.db ./corpus-mcp
```

Container: multi-stage `golang` builder → static `scratch`, `EXPOSE 8087`.
