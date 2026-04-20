-- scheme: 20260420
--
-- Initial schema for the Shruti content database.
-- Nothing shipped publicly yet, so we edit 001 in place on every
-- scheme change instead of stacking migrations.

-- Dictionaries ----------------------------------------------------------------
--
-- Flat per-locale rows — no stub parent tables. Existence of a dict
-- entry = existence of at least one (id, language) row. Keeps schema
-- small without sacrificing queryability.

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

-- Tracks ----------------------------------------------------------------------

CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,
  -- author/location may be unknown in legacy content (especially on
  -- older recordings without metadata). Keep them nullable; the app
  -- renders a fallback when they're missing.
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

CREATE TABLE track_variants (
  track_id         TEXT NOT NULL,
  language         TEXT NOT NULL,
  title            TEXT NOT NULL COLLATE NOCASE,
  audio_path       TEXT,
  audio_filesize   INTEGER,
  audio_duration   INTEGER,
  audio_kind       TEXT CHECK (audio_kind IN ('original','generated','edited')),
  transcript_path  TEXT,
  transcript_kind  TEXT CHECK (transcript_kind IN ('original','generated','edited')),
  PRIMARY KEY (track_id, language)
);

CREATE INDEX idx_track_variants_language ON track_variants(language);

-- One row per reference group. `source_id` is kept separate so the UI
-- can localise it via `sources`; `tokens` is the numeric suffix joined
-- by dots ("10.5", "10.5.12") — buildTrackRow splits on '.' for
-- display and range detection.
CREATE TABLE track_references (
  track_id  TEXT NOT NULL,
  ref_idx   INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  tokens    TEXT NOT NULL,
  PRIMARY KEY (track_id, ref_idx)
);
CREATE INDEX idx_track_references_source ON track_references(source_id);

CREATE TABLE track_tags (
  track_id TEXT,
  tag_id   TEXT,
  PRIMARY KEY (track_id, tag_id)
);

-- Search ----------------------------------------------------------------------
--
-- Single unified FTS index covering both track titles and reference
-- display strings. Populated by `importFromCouch` after the main load.
-- For references we emit one row per (raw source_id, short_name,
-- full_name) variant so users can search in any language.
--
-- We use FTS4 rather than FTS5 because the sql.js wasm on npm is
-- compiled without FTS5. FTS4 covers everything we need: same MATCH
-- syntax, same unicode61 tokenizer (with remove_diacritics=2), and
-- `notindexed=` for metadata columns. Native `@capacitor-community/
-- sqlite` supports both; sticking to FTS4 keeps the same SQL on all
-- platforms.
CREATE VIRTUAL TABLE tracks_search USING fts4(
  content,
  track_id,
  kind,
  notindexed="track_id",
  notindexed="kind",
  tokenize=unicode61 "remove_diacritics=2"
);
