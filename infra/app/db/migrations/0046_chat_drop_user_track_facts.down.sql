-- Recreate the projection 0045 introduced (empty — it is rebuilt from
-- `track.ready` redeliveries, and nothing authoritative lived here).

CREATE TABLE IF NOT EXISTS user_track_facts (
    track_id   TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
