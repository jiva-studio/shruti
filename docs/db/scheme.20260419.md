# Content DB scheme 20260419

First scheme of the prebuilt SQLite content database that ships with the Lectorium mobile app and is updated from CDN.

The database is **read-only** at runtime. The client never writes to it — it only validates the scheme by reading the last row of the `migrations` table.

## Scheme discovery

```sql
-- Returns the scheme number of the last-applied migration, or 0 if the
-- migrations table is missing / no scheme recorded.
SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1;
```

## Tables

### Dictionaries

```sql
CREATE TABLE authors         (id TEXT PRIMARY KEY);
CREATE TABLE author_names    (author_id TEXT, language TEXT, full_name TEXT NOT NULL,
                              PRIMARY KEY (author_id, language));

CREATE TABLE locations       (id TEXT PRIMARY KEY);
CREATE TABLE location_names  (location_id TEXT, language TEXT, full_name TEXT NOT NULL,
                              PRIMARY KEY (location_id, language));

CREATE TABLE sources         (id TEXT PRIMARY KEY);
CREATE TABLE source_names    (source_id TEXT, language TEXT,
                              full_name TEXT NOT NULL, short_name TEXT NOT NULL,
                              PRIMARY KEY (source_id, language));

CREATE TABLE languages       (code TEXT PRIMARY KEY,
                              full_name TEXT NOT NULL, icon TEXT);

CREATE TABLE tags            (id TEXT PRIMARY KEY);
CREATE TABLE tag_names       (tag_id TEXT, language TEXT, full_name TEXT NOT NULL,
                              PRIMARY KEY (tag_id, language));
```

Durations and sort methods are **not** stored as data — they are UI constants in `@lib/domain/durationFilters.ts` and `@lib/domain/sortMethods.ts`.

### Tracks

```sql
-- Common info, language-independent.
CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,
  author_id       TEXT NOT NULL,
  location_id     TEXT NOT NULL,
  date            TEXT,              -- ISO "YYYY-MM-DD", e.g. "1974-10-20"
  hidden          INTEGER NOT NULL DEFAULT 0,
  sort_reference  TEXT NOT NULL,     -- "sb_000001_000008_000040" for lexicographic sort
  sort_date       TEXT NOT NULL      -- "19741020" for lexicographic sort
);
CREATE INDEX idx_tracks_sort_reference ON tracks(sort_reference);
CREATE INDEX idx_tracks_sort_date      ON tracks(sort_date);
CREATE INDEX idx_tracks_author         ON tracks(author_id);
CREATE INDEX idx_tracks_location       ON tracks(location_id);
```

```sql
-- One row per (track, language). Combines title + audio + transcript file
-- paths for that language.
CREATE TABLE track_variants (
  track_id         TEXT NOT NULL,
  language         TEXT NOT NULL,
  title            TEXT NOT NULL COLLATE NOCASE,
  audio_path       TEXT,              -- full path from bucket root, or NULL
  audio_filesize   INTEGER,
  audio_duration   INTEGER,           -- milliseconds
  audio_kind       TEXT CHECK (audio_kind IN ('original','generated','edited')),
  transcript_path  TEXT,              -- full path from bucket root, or NULL
  transcript_kind  TEXT CHECK (transcript_kind IN ('original','generated','edited')),
  PRIMARY KEY (track_id, language)
);
CREATE INDEX idx_track_variants_language ON track_variants(language);
CREATE INDEX idx_track_variants_title    ON track_variants(title COLLATE NOCASE);
```

```sql
-- Reference tokens (e.g. "sb 1.8.40" → 4 rows: "sb", "1", "8", "40").
CREATE TABLE track_references (
  track_id TEXT, ord INTEGER, token TEXT NOT NULL,
  PRIMARY KEY (track_id, ord)
);

-- Many-to-many tags.
CREATE TABLE track_tags (
  track_id TEXT, tag_id TEXT,
  PRIMARY KEY (track_id, tag_id)
);
```

### Migrations

```sql
CREATE TABLE migrations (
  name       TEXT PRIMARY KEY,   -- e.g. "001_init_schema"
  scheme     INTEGER,            -- YYYYMMDD; only set when the migration changes schema
  applied_at INTEGER NOT NULL    -- unix ms at apply time
);
```

## Search

No FTS5 virtual table, no external indexes. Title search uses simple
`LIKE ? COLLATE NOCASE` against `track_variants.title` (with the index
above). Reference search (e.g. "sb 1.8.40") parses the query on the client
into tokens and matches `track_references.token` exactly.

## Path convention

All file paths in this DB (`audio_path`, `transcript_path`) are **full
paths from the bucket root**, including the `public/` prefix. The client
resolves them via `IStoragePublicUrl.get(path)` which only substitutes
`{path}` in the active CDN template.

Examples:
- `public/tracks/abc123/audio/original.mp3`
- `public/tracks/abc123/transcripts/ru.json`
