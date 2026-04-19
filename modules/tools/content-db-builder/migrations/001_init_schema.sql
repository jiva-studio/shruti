-- scheme: 20260419
--
-- Initial schema for the Lectorium content database.
-- See ../../docs/db/scheme.20260419.md for the canonical reference.

-- Dictionaries ----------------------------------------------------------------

CREATE TABLE authors (
  id TEXT PRIMARY KEY
);

CREATE TABLE author_names (
  author_id TEXT,
  language  TEXT,
  full_name TEXT NOT NULL,
  PRIMARY KEY (author_id, language)
);

CREATE TABLE locations (
  id TEXT PRIMARY KEY
);

CREATE TABLE location_names (
  location_id TEXT,
  language    TEXT,
  full_name   TEXT NOT NULL,
  PRIMARY KEY (location_id, language)
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY
);

CREATE TABLE source_names (
  source_id  TEXT,
  language   TEXT,
  full_name  TEXT NOT NULL,
  short_name TEXT NOT NULL,
  PRIMARY KEY (source_id, language)
);

CREATE TABLE languages (
  code      TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  icon      TEXT
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY
);

CREATE TABLE tag_names (
  tag_id    TEXT,
  language  TEXT,
  full_name TEXT NOT NULL,
  PRIMARY KEY (tag_id, language)
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
CREATE INDEX idx_track_variants_title    ON track_variants(title COLLATE NOCASE);

CREATE TABLE track_references (
  track_id TEXT,
  ord      INTEGER,
  token    TEXT NOT NULL,
  PRIMARY KEY (track_id, ord)
);

CREATE TABLE track_tags (
  track_id TEXT,
  tag_id   TEXT,
  PRIMARY KEY (track_id, tag_id)
);
