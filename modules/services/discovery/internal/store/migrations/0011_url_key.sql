-- Links are kept for every page and keyed the way the crawl keys addresses, so
-- a page that is not due to be fetched can still be walked through. Without it
-- the queue could only reach what was linked from a page fetched in the same
-- pass, and went empty as soon as the first sweep settled.

ALTER TABLE discovery.pages
    ADD COLUMN IF NOT EXISTS url_key text
    GENERATED ALWAYS AS (regexp_replace(regexp_replace(url, '^[A-Za-z][A-Za-z0-9+.-]*://', ''), '/$', '')) STORED;

ALTER TABLE discovery.page_links
    ADD COLUMN IF NOT EXISTS url_key text
    GENERATED ALWAYS AS (regexp_replace(regexp_replace(url, '^[A-Za-z][A-Za-z0-9+.-]*://', ''), '/$', '')) STORED;

CREATE INDEX IF NOT EXISTS pages_url_key_idx ON discovery.pages (url_key);
CREATE INDEX IF NOT EXISTS page_links_url_key_idx ON discovery.page_links (url_key);
