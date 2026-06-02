# lectorium-search

Read-only MCP server over the production pgvector corpus (`chunks` +
`chunk_embeddings_d<dim>`). It exists to **curate attributions**: find the
chunks that back a topic/question, verify their text, and feed their ids to
`lectorium-mcp`'s `library.attribution.*` tools.

It is the read/search counterpart to `lectorium-mcp` (which writes
attributions). The retrieval SQL mirrors the chat service's
`pg_chunk_repository`, and the query embedder mirrors the chat indexer
(`embed.py`) — so a hit here is the same chunk chat would retrieve.

## Why it runs on prod

The corpus lives only in the prod Postgres (pgvector). This service runs on
the origin host inside the `lectorium` docker network (reaches
`postgres:5432`) and is published **only on the host's Tailscale IP**
(`LECTORIUM_TS_IP`) — the curator's machine reaches it over the tailnet; the
public NIC is firewalled. No Caddy route, no public exposure.

## Tools

| Tool | Purpose |
|------|---------|
| `search` | Hybrid (vector ANN ⊕ lexical FTS/trigram, RRF-fused) search. `scope=transcript\|library\|all`, `mode=hybrid\|vector\|lexical`. Returns chunk text + the ids needed to attribute it. |
| `search_get` | Full text of a source by `item_id` (all segments) or `chunk_id` — verify before attributing. |
| `search_window` | Transcript chunks of a lecture overlapping a time range — the same window chat uses to resolve a `ref_kind=track` fragment. |

### From a hit to an attribution

A hit's `kind` tells you which `ref_kind` to pass to
`library.attribution.ref_add`:

| hit `kind` | attribute as | with |
|------------|-------------|------|
| `verse` | `ref_kind=verse` | `item_id` (or `source_id`+`tokens`) |
| `commentary` / `prose_chapter` / `letter` | `ref_kind=document` | `document_id` = `item_id` |
| `title` | `ref_kind=title` | `source_id`+`tokens` |
| `track_transcript` | `ref_kind=track` | `track_id` + `start_ms` + `end_ms` (a fragment) |

Lecture refs address a **fragment** (`<track_id>@<start_ms>-<end_ms>`), never
a whole lecture — a lecture covers many topics, so attribution points at the
specific passage.

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `DATABASE_URL` | — (required) | pgvector DSN |
| `OPENROUTER_API_KEY` | — | required when `EMBED_PROVIDER=openrouter` |
| `EMBED_PROVIDER` | `openrouter` | mirror chat |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | mirror chat |
| `EMBED_DIM` | `1536` | selects `chunk_embeddings_d<dim>`; must match indexed vectors |
| `EMBED_QUERY_PREFIX` | "" | mirror chat |
| `EMBED_BASE_URL` | "" | override for a self-hosted embeddings upstream |
| `SEARCH_MCP_ADDR` | `0.0.0.0:8086` | in-container listen address |

Embedding defaults intentionally match the chat indexer's. If chat's
`EMBED_*` are ever overridden, set the same values here or query vectors land
in a different space than the indexed chunks.

## Client

Reached over the tailnet (plain HTTP; the tailnet encrypts):

```json
"lectorium-search": { "type": "http", "url": "http://lectorium-prod-eu:8086/mcp" }
```
