-- Shruti chat schema. Idempotent: safe to apply on every startup.
-- See plan §"Data model" for the rationale.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
    id                  BIGSERIAL PRIMARY KEY,
    track_id            TEXT NOT NULL,
    lang                TEXT NOT NULL,
    start_ms            INT NOT NULL,
    end_ms              INT NOT NULL,
    text                TEXT NOT NULL,
    reference_source_id TEXT,
    embed_model         TEXT NOT NULL,
    embedding           vector(1536) NOT NULL   -- text-embedding-3-small dim
);
CREATE INDEX IF NOT EXISTS chunks_track ON chunks (track_id, lang);
CREATE INDEX IF NOT EXISTS chunks_model ON chunks (embed_model);
CREATE INDEX IF NOT EXISTS chunks_hnsw
    ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS indexed_tracks (
    track_id    TEXT NOT NULL,
    lang        TEXT NOT NULL,
    embed_model TEXT NOT NULL,
    etag        TEXT NOT NULL,
    indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (track_id, lang, embed_model)
);

CREATE TABLE IF NOT EXISTS catalog_state (
    id              INT PRIMARY KEY DEFAULT 1,
    current_version TEXT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS usage (
    key   TEXT NOT NULL,
    day   DATE NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (key, day)
);

CREATE TABLE IF NOT EXISTS indexer_runs (
    id            BIGSERIAL PRIMARY KEY,
    run_id        TEXT NOT NULL UNIQUE,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    state         TEXT NOT NULL,
    trigger       TEXT NOT NULL,
    catalog_from  TEXT,
    catalog_to    TEXT,
    tracks_total  INT,
    tracks_done   INT,
    chunks_total  INT,
    error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_indexer_runs_started
    ON indexer_runs (started_at DESC);
