-- Restore the ACL projection 0044 created and hand the rows back. The author
-- columns are dropped with the table: they are rebuilt from `track.ready`.

CREATE TABLE IF NOT EXISTS owned (
    user_id    TEXT NOT NULL,
    track_id   TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, track_id)
);
CREATE INDEX IF NOT EXISTS owned_track_id ON owned (track_id);

INSERT INTO owned (user_id, track_id, created_at)
SELECT owner_id, track_id, updated_at FROM chunk_meta
    ON CONFLICT (user_id, track_id) DO NOTHING;

DROP TABLE IF EXISTS chunk_meta;
