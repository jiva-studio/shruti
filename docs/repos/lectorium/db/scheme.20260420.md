# Content DB scheme 20260420

> **Looking for an explanation?** This page is the versioned **raw-SQL snapshot** of the content database. For human-readable per-table descriptions see [`content-db.md`](./content-db.md), for the visual ER diagram see [`er-diagram.md`](./er-diagram.md), and for the broader two-DB picture see [`README.md`](./README.md).

Historical `20260420` snapshot of the prebuilt SQLite content database that
ships with the Lectorium mobile app and is updated from CDN. The **current**
scheme is `20260614` (later revisions rename `packs`/`pack_tracks` to
`collections`/`collection_tracks`, add the `track_audio` table for multiple
audio versions, add `outline`/`description` columns to `track_variants`,
`image`/`description` columns to `authors`, and the `topics`/`track_topics`
tables — see [`content-db.md`](./content-db.md)); this page is kept as the
dated record of the prior shape and intentionally does not reflect those later
changes.

The publisher owns the schema: the catalog writer in the Go MCP
([`modules/tools/lectorium-mcp/internal/infra/catalog/sqlite/migrate.go`](https://github.com/jiva-studio/lectorium/blob/main/modules/tools/lectorium-mcp/internal/infra/catalog/sqlite/migrate.go))
seeds canonical kind-tags, records a `migrations` row, and ensures the FTS
index. The scheme number the client is built against lives in
[`modules/db-scheme.json`](https://github.com/jiva-studio/lectorium/blob/main/modules/db-scheme.json).

The database is **read-only** at runtime. The client never writes to it — it only validates the scheme by reading the last row of the `migrations` table.

## Scheme discovery

```sql
-- Returns the scheme number of the last-applied migration, or 0 if the
-- migrations table is missing / no scheme recorded.
SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1;
```

## Tables

### Dictionaries

Flat per-locale rows — no stub parent tables. Existence of a dictionary
entry = existence of at least one `(id, language)` row. Keeps the schema
small without sacrificing queryability.

```sql
CREATE TABLE authors (
  id        TEXT NOT NULL,
  language  TEXT NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
);

CREATE TABLE locations (
  id        TEXT NOT NULL,
  language  TEXT NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
);

CREATE TABLE sources (
  id         TEXT NOT NULL,
  language   TEXT NOT NULL,
  full_name  TEXT NOT NULL,
  short_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
);

CREATE TABLE tags (
  id        TEXT NOT NULL,
  language  TEXT NOT NULL,
  full_name TEXT NOT NULL,
  PRIMARY KEY (id, language)
);

-- `languages` is the registry of available languages itself, so its
-- metadata isn't per-locale — code is the PK.
CREATE TABLE languages (
  code      TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  icon      TEXT
);
```

Durations and sort methods are **not** stored as data — they are UI constants in `@lib/domain/durationFilters.ts` and `@lib/domain/sortMethods.ts`.

### Tracks

```sql
-- Common info, language-independent.
-- author/location may be unknown in legacy content (older recordings
-- without metadata), so both are nullable; the app renders a fallback
-- when missing.
CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,
  author_id       TEXT,
  location_id     TEXT,
  date            TEXT,              -- ISO "YYYY-MM-DD", e.g. "1974-10-20"
  hidden          INTEGER NOT NULL DEFAULT 0,
  sort_reference  TEXT NOT NULL,
  sort_date       TEXT NOT NULL
);
CREATE INDEX idx_tracks_sort_reference ON tracks(sort_reference);
CREATE INDEX idx_tracks_sort_date      ON tracks(sort_date);
CREATE INDEX idx_tracks_author         ON tracks(author_id);
CREATE INDEX idx_tracks_location       ON tracks(location_id);
```

```sql
-- One row per (track, language). Combines title + audio + transcript
-- file paths for that language.
CREATE TABLE track_variants (
  track_id         TEXT NOT NULL,
  language         TEXT NOT NULL,
  title            TEXT NOT NULL COLLATE NOCASE,
  audio_path       TEXT,              -- full path from bucket root, or NULL
  audio_filesize   INTEGER,
  audio_duration   INTEGER,            -- milliseconds
  audio_kind       TEXT CHECK (audio_kind IN ('original','generated','edited')),
  transcript_path  TEXT,              -- full path from bucket root, or NULL
  transcript_kind  TEXT CHECK (transcript_kind IN ('original','generated','edited')),
  PRIMARY KEY (track_id, language)
);
CREATE INDEX idx_track_variants_language ON track_variants(language);
```

```sql
-- One row per reference group. `source_id` is kept separate so the UI
-- can localise it via `sources`; `tokens` is the numeric suffix joined
-- by dots ("10.5", "10.5.12") — `buildTrackRow` splits on '.' for
-- display and range detection.
CREATE TABLE track_references (
  track_id  TEXT NOT NULL,
  ref_idx   INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  tokens    TEXT NOT NULL,
  PRIMARY KEY (track_id, ref_idx)
);
CREATE INDEX idx_track_references_source ON track_references(source_id);

-- Many-to-many tags.
CREATE TABLE track_tags (
  track_id TEXT,
  tag_id   TEXT,
  PRIMARY KEY (track_id, tag_id)
);
```

### Migrations

The `migrations` table records the applied scheme. The catalog publisher
([`catalog/sqlite/migrate.go`](https://github.com/jiva-studio/lectorium/blob/main/modules/tools/lectorium-mcp/internal/infra/catalog/sqlite/migrate.go))
inserts a row on publish; the mobile scheme-validator reads the top row
(`ORDER BY name DESC LIMIT 1`) to accept or reject the DB.

```sql
CREATE TABLE migrations (
  name       TEXT PRIMARY KEY,   -- e.g. "001_init_schema"
  scheme     INTEGER,            -- YYYYMMDD; only set when the migration changes scheme
  applied_at INTEGER NOT NULL    -- unix ms at apply time
);
```

## Search (FTS4)

A single unified FTS4 virtual table covers both track titles and
reference display strings. The publisher emits one `kind='combined'` row
per track — concatenating titles plus localised reference strings across
languages — so a single `MATCH` over `kind='combined'` rows searches
everything in any language. `backfillCombinedFtsRows` in
[`catalog/sqlite/migrate.go`](https://github.com/jiva-studio/lectorium/blob/main/modules/tools/lectorium-mcp/internal/infra/catalog/sqlite/migrate.go)
rebuilds these rows when missing.

```sql
CREATE VIRTUAL TABLE tracks_search USING fts4(
  content,
  track_id,
  kind,
  notindexed="track_id",
  notindexed="kind",
  tokenize=unicode61 "remove_diacritics=2"
);
```

**Why FTS4 and not FTS5.** The `sql.js` wasm on npm is compiled without
FTS5. FTS4 covers everything needed (same `MATCH` syntax, same
`unicode61` tokenizer with `remove_diacritics=2`, and `notindexed=` for
metadata columns). Native `@capacitor-community/sqlite` supports both;
sticking to FTS4 keeps the same SQL on every platform.

Reference search (e.g. "sb 1.8.40") is parsed on the client into tokens
and matches via the FTS index plus exact `track_references.tokens`
prefix matching.

## Path convention

All file paths in this DB (`audio_path`, `transcript_path`) are **full
paths from the bucket root**, including the `public/` prefix. The client
resolves them via `IStoragePublicUrl.get(path)`, which only substitutes
`{path}` in the active CDN template.

Examples:

- `public/tracks/abc123/audio/original.mp3`
- `public/tracks/abc123/transcripts/ru.json`
