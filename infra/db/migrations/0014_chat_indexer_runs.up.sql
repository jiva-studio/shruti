-- Indexer-run log. One row per catalog tick (manual or scheduled).
-- Surfaced in /status admin endpoint for ops visibility.

CREATE TABLE indexer_runs (
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
CREATE INDEX idx_indexer_runs_started ON indexer_runs (started_at DESC);
