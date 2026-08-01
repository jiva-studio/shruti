-- A page whose recheck has not come around was dropped from the queue
-- entirely, and with it every address it was the only one pointing at. The
-- crawl could therefore only ever reach what was linked from a page it fetched
-- in the same pass. Once the first sweep had settled — 1416 pages, all of them
-- scheduled a day out — the seed itself was not due, nothing was fetched,
-- nothing was discovered, and three consecutive runs took zero pages while the
-- archive still held a quarter of a million files.
--
-- Not fetching a page and not walking through it are different things. What a
-- page pointed at is already known; it does not have to be asked again to be
-- traversed. Keeping the links of every page, not just the ones that offered
-- no audio, and keying them the way the queue keys addresses, makes the
-- unexplored edge answerable as a query.

ALTER TABLE discovery.pages
    ADD COLUMN IF NOT EXISTS url_key text
    GENERATED ALWAYS AS (regexp_replace(regexp_replace(url, '^[A-Za-z][A-Za-z0-9+.-]*://', ''), '/$', '')) STORED;

ALTER TABLE discovery.page_links
    ADD COLUMN IF NOT EXISTS url_key text
    GENERATED ALWAYS AS (regexp_replace(regexp_replace(url, '^[A-Za-z][A-Za-z0-9+.-]*://', ''), '/$', '')) STORED;

CREATE INDEX IF NOT EXISTS pages_url_key_idx ON discovery.pages (url_key);
CREATE INDEX IF NOT EXISTS page_links_url_key_idx ON discovery.page_links (url_key);
