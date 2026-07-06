-- profile schema — the device<->server sync substrate.
--
-- Two tables are sync infrastructure (the append-only change log and the
-- per-device cursor); the rest are typed projections of the latest state
-- for reads and analytics. All state PKs are composite on user_id so the
-- chat FK can cascade within a user.

CREATE SCHEMA IF NOT EXISTS profile;

-- Append-only change log: the authority for both sync and conflict
-- detection. global_seq is the single monotonic pull cursor.
CREATE TABLE profile.changes (
    global_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    uuid   NOT NULL,
    collection text   NOT NULL,
    doc_id     text   NOT NULL,
    op         text   NOT NULL CHECK (op IN ('upsert','delete')),
    data       jsonb,
    hlc        text   NOT NULL,
    device_id  text   NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, collection, doc_id, hlc)          -- push idempotency
);
CREATE INDEX changes_pull_idx ON profile.changes (user_id, global_seq);
CREATE INDEX changes_doc_idx  ON profile.changes (user_id, collection, doc_id, global_seq DESC);

-- Highest global_seq each device has acknowledged; drives resume and
-- log compaction.
CREATE TABLE profile.sync_cursors (
    user_id    uuid        NOT NULL,
    device_id  text        NOT NULL,
    acked_seq  bigint      NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, device_id)
);

-- Typed state projections. -----------------------------------------------

CREATE TABLE profile.playlist_items (
    user_id       uuid        NOT NULL,
    doc_id        text        NOT NULL,   -- = track_id (natural key)
    track_id      text        NOT NULL,
    added_at      timestamptz,
    archived_at   timestamptz,            -- null = active
    collection_id text,                   -- provenance, nullable
    PRIMARY KEY (user_id, doc_id)
);

CREATE TABLE profile.listening_sessions (
    user_id         uuid        NOT NULL,
    doc_id          text        NOT NULL, -- ls_...
    item_id         text,                 -- nullable
    track_id        text,                 -- denormalized for analytics
    started_at      timestamptz,
    ended_at        timestamptz,
    from_position   int,
    to_position     int,
    PRIMARY KEY (user_id, doc_id)
);

CREATE TABLE profile.notes (
    user_id      uuid        NOT NULL,
    doc_id       text        NOT NULL,    -- note_...
    track_id     text,
    text         text,                    -- note body; column name matches the client user.db (`text`)
    time_start   int,
    time_end     int,
    created_at   timestamptz,
    updated_at   timestamptz,             -- for LWW
    meta         jsonb,                   -- nullable
    PRIMARY KEY (user_id, doc_id)
);

CREATE TABLE profile.chat_sessions (
    user_id    uuid        NOT NULL,
    doc_id     text        NOT NULL,      -- uuid
    title      text,                      -- nullable
    track_id   text,                      -- nullable anchor
    created_at timestamptz,
    updated_at timestamptz,
    PRIMARY KEY (user_id, doc_id)
);

CREATE TABLE profile.chat_messages (
    user_id    uuid        NOT NULL,
    doc_id     text        NOT NULL,      -- uuid
    session_id text        NOT NULL,      -- cascade parent
    role       text,                      -- user | assistant
    content    text,
    meta       jsonb,                     -- versioned envelope
    created_at timestamptz,
    PRIMARY KEY (user_id, doc_id),
    -- Composite FK on (user_id, session_id) -> chat_sessions(user_id, doc_id):
    -- deleting a session removes its messages server-side too, mirroring the
    -- client cascade.
    FOREIGN KEY (user_id, session_id)
        REFERENCES profile.chat_sessions (user_id, doc_id) ON DELETE CASCADE
);
CREATE INDEX chat_messages_session_idx
    ON profile.chat_messages (user_id, session_id);
