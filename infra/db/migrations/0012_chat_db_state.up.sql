-- Source DB state — current local version of each downloadable artifact
-- (catalog/current.db, library/library.db). Tracked per kind.

CREATE TABLE db_state (
    kind            TEXT PRIMARY KEY,        -- 'catalog' | 'library'
    current_version TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
