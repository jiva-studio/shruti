-- Shruti MCP lake registry — schema v1.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS files (
  path         TEXT    NOT NULL PRIMARY KEY, -- absolute, EvalSymlinks-resolved
  track_id     TEXT    NOT NULL UNIQUE,
  sha256       TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL,
  ingested_at  TEXT    NOT NULL              -- RFC3339
);
CREATE INDEX IF NOT EXISTS files_track_id ON files(track_id);

CREATE TABLE IF NOT EXISTS stages (
  track_id     TEXT NOT NULL,
  stage        TEXT NOT NULL,                -- ingested|normalized|metadata|transcribed|reviewed|committed
  variant      TEXT NOT NULL DEFAULT '',     -- '' = language-agnostic; otherwise language code
  status       TEXT NOT NULL,                -- pending|running|done|failed
  started_at   TEXT,
  finished_at  TEXT,
  error        TEXT,
  payload_json TEXT,
  PRIMARY KEY (track_id, stage, variant),
  FOREIGN KEY (track_id) REFERENCES files(track_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS stages_status ON stages(stage, status);

CREATE TABLE IF NOT EXISTS dict_resolution_cache (
  query        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  language     TEXT NOT NULL DEFAULT '',
  matched_id   TEXT,
  confidence   TEXT NOT NULL,
  reasoning    TEXT,
  provider     TEXT NOT NULL,
  resolved_at  TEXT NOT NULL,
  PRIMARY KEY (query, kind, language)
);
CREATE INDEX IF NOT EXISTS dict_cache_resolved_at ON dict_resolution_cache(resolved_at);
CREATE INDEX IF NOT EXISTS dict_cache_matched_id  ON dict_resolution_cache(kind, matched_id);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);
