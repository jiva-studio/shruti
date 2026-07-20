-- library_items — the Personal Library projection.
--
-- Unlike the other state tables (typed projections of client-pushed rows),
-- library_items is 100% SERVER-OWNED: the single writer is the server-authored
-- write path (Service.ApplyServerChange, device_id 'server:orchestrator').
-- Clients treat it as PULL-ONLY — they never push it — so there is no
-- field-ownership split and no *_edits companion table. Every column below is
-- written only by the server as it fetches/normalizes a library membership.
--
-- PK (user_id, doc_id) matches every other state table; doc_id is the library
-- membership id (a uuid). track_id is nullable until the track is fetched.

CREATE TABLE profile.library_items (
    user_id         uuid        NOT NULL,
    doc_id          text        NOT NULL,   -- library membership id (uuid)
    track_id        text,                    -- nullable until the track is fetched
    status          text,                    -- fetch/normalize lifecycle state
    origin          text,                    -- how the item entered the library
    error           text,                    -- last failure detail, nullable
    -- raw, as-submitted metadata (pre-normalization) --------------------------
    title_raw       text,
    author_raw      text,
    location_raw    text,
    date_raw        text,
    lang_hint       text,
    -- normalized / resolved metadata ------------------------------------------
    author_id       text,
    location_id     text,
    date            text,                    -- normalized date (precision below)
    date_precision  text,                    -- year | month | day
    lang            text,
    lang_confidence double precision,
    -- resolved media artifacts ------------------------------------------------
    audio_key       text,
    transcript_key  text,
    cover_key       text,
    duration        int,                     -- seconds, nullable until known
    added_at        timestamptz,
    PRIMARY KEY (user_id, doc_id)
);
