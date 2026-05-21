# attribution-importer

Bulk-imports `library.attribution.*` entries into `library.db` from a curated
YAML file via the lectorium-mcp HTTP endpoint. Idempotent, resumable,
single-purpose.

## Why this exists

`library.attribution.*` MCP tools are designed for **one-at-a-time** curator
edits (UI-friendly, validates each ref against the library). When a curator
prepares an attribution plan for hundreds of verses at once — like the
108-essential-Bhagavad-Gita memorization course — calling them by hand
through `mcp call` is impractical.

This tool reads a verse-centric YAML plan, aggregates it into
attribution-centric calls (one attribution per unique topic/question text
across all verses), and drives the MCP daemon to materialise them. Picks
up from a checkpoint if interrupted.

## When to use

- Seeding initial attributions from a curated list (this is the primary
  use-case — populating the empty `library_attributions` table).
- Bulk-revising attributions when the source list is regenerated (rerun
  with the same checkpoint to skip already-created entries; new entries
  in the YAML are added).
- One-off imports of memorization courses, lecture-cluster maps,
  topic-glossaries, anything that can be expressed as
  `verse → [topics, questions]`.

When **NOT** to use:

- Single edits — use `mcp call library.attribution.*` directly.
- Editing existing attributions (the importer only CREATEs and ADDs;
  it doesn't UPDATE text or REMOVE refs).

## YAML input format

```yaml
# Required header — identifies the source book and the curator's language.
# The MCP server auto-translates `language` text into every other lang in
# `settings.langs` on create. Curator can then edit translations via
# library.attribution.text_set.
source_id: source_dsicuBsFvinZ      # the BG source id in catalog.db
language: ru                         # source language of all `topics`/`questions` below

verses:
  - tokens: "2.13"                   # chapter.verse (matches library_verses.tokens)
    verse_id: verse_t2L2UxZM1uxi     # opaque library_verses.id (must already exist)
    topics:                          # short labels (1-4 words) for kind=topic
      - "реинкарнация"
      - "природа души"
      - "тело и душа"
    questions:                       # user-phrasings for kind=question
      - "что такое реинкарнация"
      - "что такое душа"
      - "переходит ли душа в другое тело"

  - tokens: "2.20"
    verse_id: verse_mdxjeli4FfYq
    topics:
      - "бессмертие души"
      - "природа души"               # SHARED with 2.13 → same attribution, two refs
    questions:
      - "что такое душа"             # SHARED with 2.13 → same attribution, two refs
      - "бессмертна ли душа"
```

Aggregation: text dedup is exact-match (case- and whitespace-sensitive).
`"что такое душа"` and `"Что такое душа"` become **two** attributions.

## Aggregation algorithm

1. Build `topic_text → set(verse_id)` and `question_text → set(verse_id)` maps
   across every entry in `verses`.
2. For each unique `(kind, text)` pair, create ONE attribution; add a ref
   for every `verse_id` in the set.
3. Refs are by `target_id` — the YAML's `verse_id` becomes
   `ref_kind=verse, target_id=<verse_id>` directly (no resolve needed).

So 108 verses × 3 topics avg = 324 topic-mentions in YAML → ~80-100 unique
topics (after dedup) → 80-100 attribution.create calls. Similarly for
questions.

## Checkpoint file

`state/<yaml-basename>.checkpoint.json`. Stores:

```json
{
  "yaml_path": "/abs/path/to/bg_108_essential.yaml",
  "started_at": "2026-05-21T10:00:00Z",
  "attributions": {
    "topic:природа души":   "attribution_xVyZ0e",
    "question:что такое душа": "attribution_aQ8mNk"
  },
  "refs_added": [
    "attribution_xVyZ0e:verse:verse_t2L2UxZM1uxi",
    "attribution_xVyZ0e:verse:verse_mdxjeli4FfYq"
  ]
}
```

The checkpoint is the **single source of truth for resume**. On every
restart the importer reads it and skips any (kind+text) already in
`attributions`, and any (attr_id, ref_kind, target_id) already in
`refs_added`. Delete the file to force a full re-import (existing rows
will fail with PK conflict in SQLite — graceful as INSERT OR IGNORE on
the MCP side... no, actually `library.attribution.create` does NOT
dedupe by text — it always creates a new attribution row with a fresh
nanoid. So `rm state/...checkpoint.json && python import_attributions.py`
**WILL DOUBLE-CREATE**. Don't do it. Use `--reset-state` flag instead
which prompts for confirmation.)

## How it talks to MCP

JSON-RPC 2.0 over HTTP at `http://127.0.0.1:8081/mcp` (the streamable
HTTP transport that lectorium-mcp serves). Sends one `tools/call`
request per attribution-create / ref-add. No SSE, no streaming — every
call is one round-trip.

Default daemon address is read from `lectorium-mcp.yaml` in the daemon's
working dir (`addr` field, defaults to `127.0.0.1:8081`). Override via
`--mcp-url http://...`.

## CLI

```bash
# Dry run — prints planned operations, does NOT modify library.db
python import_attributions.py bg_108_essential.yaml --dry-run

# Real import (idempotent — uses checkpoint).
python import_attributions.py bg_108_essential.yaml

# Custom MCP endpoint
python import_attributions.py bg_108_essential.yaml --mcp-url http://localhost:8081/mcp

# Force fresh state (with confirmation prompt — would re-create attributions)
python import_attributions.py bg_108_essential.yaml --reset-state

# Publish library.db to S3 after a successful import
python import_attributions.py bg_108_essential.yaml --publish
```

## Output

Progress lines on stdout: one per attribution created and one per ref added.
Errors logged to stderr. Final summary:

```
[summary]
  yaml         bg_108_essential.yaml
  verses       108
  topics       97 unique (84 created, 13 already present)
  questions    132 unique (132 created, 0 already present)
  refs added   573
  errors       0
  elapsed      48.2s
```

## Layout

```
modules/tools/attribution-importer/
├── README.md                — this file
├── requirements.txt         — httpx, pyyaml
├── import_attributions.py   — the importer
└── state/                   — checkpoint files (gitignored)
    └── *.checkpoint.json
```

## Dependencies

- Python 3.11+
- `httpx` (sync mode is enough — no parallelism needed at this scale)
- `pyyaml`

```bash
pip install -r requirements.txt
```

## Future inputs

The YAML format is intentionally generic — any verse-centric attribution
plan can be imported with the same script. Likely future files:

- `sb_108_essential.yaml`        — Srimad-Bhagavatam memorization course
- `cc_essential.yaml`            — Chaitanya-charitamrita key verses
- `topics_seed_<theme>.yaml`     — single-topic deep curation (e.g. all
                                   verses about karma, all verses about gunas)

Document(non-verse) refs are also supported by the YAML schema even
though `bg_108_essential.yaml` doesn't use them yet:

```yaml
verses:
  - tokens: "2.13"
    verse_id: verse_t2L2UxZM1uxi
    documents:                          # extra refs to commentaries / prose
      - "library_document_xxx"          # Prabhupada's purport on BG 2.13
    topics: [...]
    questions: [...]
```
