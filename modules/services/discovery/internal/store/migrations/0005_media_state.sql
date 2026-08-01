-- Two things you have to be able to ask afterwards, and could not:
--
--   which pages did we visit and find no file on at all
--   which files were there once and are not any more
--
-- The first is a count on the page. A page that yields nothing is not a
-- failure — it may be a menu, or it may be a lecture whose audio sits behind an
-- account we are not signed in to — and the only honest record is that we were
-- there and saw none.
--
-- The second is a state plus two dates on the record. A flag cannot tell a
-- session that expired an hour ago from a file removed last spring; the dates
-- can, without anyone having to decide which it was at the moment it happened.

ALTER TABLE discovery.pages ADD COLUMN IF NOT EXISTS media_found integer NOT NULL DEFAULT 0;

ALTER TABLE discovery.items ADD COLUMN IF NOT EXISTS media_state text NOT NULL DEFAULT 'present';
-- When the address of the file was last on the page.
ALTER TABLE discovery.items ADD COLUMN IF NOT EXISTS media_seen_at timestamptz;
-- The FIRST visit that did not find it, not the latest. How long it has been
-- gone is the whole signal.
ALTER TABLE discovery.items ADD COLUMN IF NOT EXISTS media_missing_since timestamptz;

UPDATE discovery.items SET media_seen_at = last_seen_at WHERE media_seen_at IS NULL;

ALTER TABLE discovery.items DROP COLUMN IF EXISTS media_available;
ALTER TABLE discovery.items DROP COLUMN IF EXISTS media_blocked;

-- Pages already visited get their count from what they already yielded, or the
-- "we found nothing here" view would accuse every page indexed before today.
UPDATE discovery.pages p
SET media_found = (SELECT count(*) FROM discovery.items i WHERE i.page_id = p.id)
WHERE media_found = 0;

CREATE INDEX IF NOT EXISTS items_media_state_idx
    ON discovery.items (media_state) WHERE media_state <> 'present';
CREATE INDEX IF NOT EXISTS pages_no_media_idx
    ON discovery.pages (last_fetched_at) WHERE media_found = 0;
