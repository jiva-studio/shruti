-- Server-side ownership projection for private user-track RAG (#1227).
--
-- `owned` is the authoritative ACL for the private lecture lane: which
-- user (JWT `sub`) may retrieve which `user_track`. It is a PROJECTION
-- maintained by the chat service's `track.events` consumer — upserted on
-- `track.ready` / `track.linked`, deleted on `library.unlinked`. Retrieval
-- resolves the eligible track-id set from THIS table keyed on the request's
-- verified `sub` — never from client-supplied `recent_tracks` — so a client
-- cannot widen its own ACL.
--
-- No FK to `chunks`: ownership is asserted from the library/orchestrator
-- events independently of whether the transcript has finished indexing yet,
-- and a track may be owned by several users (a shared upload) — the
-- composite PK is (user_id, track_id).

CREATE TABLE IF NOT EXISTS owned (
    user_id    TEXT NOT NULL,
    track_id   TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, track_id)
);

-- Reverse lookup: "who owns this track" — used when a track is unindexed
-- or an event fans out to the owners. The (user_id, ...) direction is
-- already covered by the PK's leading column.
CREATE INDEX IF NOT EXISTS owned_track_id ON owned (track_id);
