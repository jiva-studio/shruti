-- What we know ABOUT a privately added track, as the ingest reported it.
--
-- The private lecture lane could tell WHO owns a track (`owned`) but nothing
-- about what it is — so an answer narrowed to a chosen lecturer had to drop the
-- whole personal library, including that lecturer's own talks. The `track.ready`
-- event already carries the metadata (`author_raw`, `title_raw`, `location_raw`,
-- `date`, `references`, …); this stores it verbatim so retrieval can ask.
--
-- Keyed by track_id ALONE, with no user column: a track id is a content hash, so
-- two people who add the same recording share one row — the facts describe the
-- recording, not anyone's copy of it. Ownership stays entirely in `owned`.
--
-- Raw JSON on purpose. The names are unresolved free text ("His Grace Radhanath
-- Swami", "Прабхупада") and normalizing them here would freeze one resolution
-- strategy into the schema; the resolver lives in code and can improve without a
-- migration. No index either: every read is a point lookup by primary key on a
-- handful of ids the caller already holds.

CREATE TABLE IF NOT EXISTS user_track_facts (
    track_id   TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
