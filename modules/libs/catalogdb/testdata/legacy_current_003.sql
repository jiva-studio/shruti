CREATE TABLE languages (
  code      TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  icon      TEXT
);

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

CREATE TABLE tracks (
  id              TEXT PRIMARY KEY,
  -- author/location may be unknown in legacy content (especially on
  -- older recordings without metadata). Keep them nullable; the app
  -- renders a fallback when they're missing.
  author_id       TEXT,
  location_id     TEXT,
  date            TEXT,              -- ISO "YYYY-MM-DD", e.g. "1974-10-20"
  hidden          INTEGER NOT NULL DEFAULT 0);

CREATE TABLE track_variants (
  track_id         TEXT NOT NULL,
  language         TEXT NOT NULL,
  title            TEXT NOT NULL COLLATE NOCASE,
  audio_path       TEXT,
  audio_filesize   INTEGER,
  audio_duration   INTEGER,
  audio_kind       TEXT CHECK (audio_kind IN ('original','generated','edited')),
  transcript_path  TEXT,
  transcript_kind  TEXT CHECK (transcript_kind IN ('original','generated','edited')), sort_reference TEXT,
  PRIMARY KEY (track_id, language)
);

CREATE TABLE track_references (
  track_id  TEXT NOT NULL,
  ref_idx   INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  tokens    TEXT NOT NULL,
  PRIMARY KEY (track_id, ref_idx)
);

CREATE TABLE track_tags (
  track_id TEXT,
  tag_id   TEXT,
  PRIMARY KEY (track_id, tag_id)
);

CREATE TABLE migrations (
  name       TEXT PRIMARY KEY,
  scheme     INTEGER,
  applied_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE tracks_search USING fts4(
  content,
  track_id,
  kind,
  notindexed="track_id",
  notindexed="kind",
  tokenize=unicode61 "remove_diacritics=2"
);

CREATE TABLE packs (
			id          TEXT NOT NULL,
			language    TEXT NOT NULL,
			name        TEXT NOT NULL,
			sort_order  INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (id, language)
		);

CREATE TABLE pack_tracks (
			pack_id        TEXT NOT NULL,
			pack_language  TEXT NOT NULL,
			track_id       TEXT NOT NULL,
			position       INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (pack_id, pack_language, track_id),
			FOREIGN KEY (pack_id, pack_language) REFERENCES packs(id, language) ON DELETE CASCADE
		);

CREATE INDEX idx_pack_tracks_pack ON pack_tracks(pack_id, pack_language, position);

CREATE INDEX idx_track_references_source ON track_references(source_id);

CREATE INDEX idx_track_variants_language ON track_variants(language);

CREATE INDEX idx_track_variants_sort_reference
  ON track_variants(language, sort_reference);

CREATE INDEX idx_tracks_author         ON tracks(author_id);

CREATE INDEX idx_tracks_location       ON tracks(location_id);

INSERT INTO migrations (name, scheme, applied_at) VALUES
  ('001_init_schema', 20260420, 1777730421448),
  ('002_drop_sort_cache', 20260512, 1778608239000),
  ('003_add_packs', 20260520, 1779260074479);
