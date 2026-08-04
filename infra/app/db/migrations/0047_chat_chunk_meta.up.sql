-- One record per group of chunks: who may read it, and what the ingest said
-- about it. Replaces `owned` (0044) and the metadata attempts around it (0045,
-- 0046).
--
-- WHY THIS SHAPE ────────────────────────────────────────────────────────
-- Chat's domain is chunks and what it knows about them. A "user library" is
-- someone else's concern — the orchestrator owns the job, the profile service
-- owns `library_items` — so nothing here models one. What retrieval needs is
-- exactly two answers about a group of chunks: may THIS person search it, and
-- who is speaking on it. Both live in one row.
--
-- Keyed by (owner_id, track_id), one row per owner, because the private lane's
-- only hot question is "what may this person read" — that is one index scan on
-- the primary key's leading column, no join and no array containment. A track id
-- is a content hash, so two people who add the same recording get two rows with
-- the same values; the duplication is a handful of short strings, and it is also
-- honest: the metadata comes from whoever's ingest produced it, and two ingests
-- of the same audio can disagree.
--
-- `owner_id` stays TEXT, like `owned.user_id` before it: it is the verified JWT
-- `sub`, which is not guaranteed to be a UUID.
--
-- Only fields with a reader: `author_id` (the lecturer filter joins on it) and
-- `author_raw` (the filter for a teacher the CORPUS does not know, re-resolution
-- when the dictionary learns a name, and the count of unattributed uploads an
-- answer admits to). Titles, places and dates are not here — nothing in chat
-- reads them, and 0045 shipped them anyway. When a reader appears, so can a
-- column.
--
-- A row lives as long as its chunks: written on `track.ready`, deleted when its
-- owner unlinks, when the chunks are unindexed, and when the track is promoted
-- into the public corpus (after which the catalog is the authority).

CREATE TABLE IF NOT EXISTS chunk_meta (
    owner_id   TEXT NOT NULL,
    track_id   TEXT NOT NULL,
    author_id  TEXT,
    author_raw TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (owner_id, track_id)
);

-- Reverse lookup: who sees this group. Used when a track is unindexed or
-- promoted, and to decide whether anyone still holds it.
CREATE INDEX IF NOT EXISTS chunk_meta_track_id ON chunk_meta (track_id);

-- Carry the existing ACL over. The author columns stay NULL and fill in on the
-- next `track.ready` for each track — which is also today's state, since no
-- private chunk has ever carried a resolved author.
INSERT INTO chunk_meta (owner_id, track_id, updated_at)
SELECT user_id, track_id, created_at FROM owned
    ON CONFLICT (owner_id, track_id) DO NOTHING;

DROP TABLE IF EXISTS owned;

-- 0046 began stamping the speaker on every private chunk. It is one attribute of
-- the group, so it belongs to the row above — and no lecture chunk in the public
-- corpus carries an author either (0 of 524k).
UPDATE chunks SET author_id = NULL WHERE kind = 'user_track';
