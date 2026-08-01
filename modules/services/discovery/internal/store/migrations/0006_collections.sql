-- A cycle of talks is stated plainly on both sides: the series page lists its
-- parts in order, and each part names the series it belongs to. We were
-- throwing both away — links went to the crawl frontier and were never stored,
-- so by the time the parts existed there was nothing left to join them with.
--
-- The ordering problem is why membership cannot be resolved when it is read:
-- indexing the series page happens before its parts exist, and indexing a part
-- happens before the series page is fetched. Whichever arrives first has to be
-- able to wait for the other.

-- Kept only for pages that offered no media — the side a series page is on.
-- Storing every link on every page would be an order of magnitude more rows
-- for nothing.
CREATE TABLE IF NOT EXISTS discovery.page_links (
    page_id bigint NOT NULL REFERENCES discovery.pages(id) ON DELETE CASCADE,
    ordinal integer NOT NULL,
    url     text NOT NULL,
    PRIMARY KEY (page_id, ordinal)
);

-- A series page's URL is its identity when there is one. When there is not —
-- an archive that names the cycle on each part and has no page for it — the
-- title within a source has to serve.
CREATE UNIQUE INDEX IF NOT EXISTS collections_url_idx
    ON discovery.collections (source_id, url) WHERE url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS collections_title_idx
    ON discovery.collections (source_id, title) WHERE url IS NULL;

-- Membership is recorded by page URL first and resolved to a recording later,
-- so a series page can list parts that have not been indexed yet.
DROP TABLE IF EXISTS discovery.collection_items;
CREATE TABLE IF NOT EXISTS discovery.collection_members (
    collection_id bigint NOT NULL REFERENCES discovery.collections(id) ON DELETE CASCADE,
    ordinal       integer NOT NULL,
    page_url      text NOT NULL DEFAULT '',
    item_id       bigint REFERENCES discovery.items(id) ON DELETE SET NULL,
    PRIMARY KEY (collection_id, ordinal)
);

CREATE INDEX IF NOT EXISTS collection_members_pending_idx
    ON discovery.collection_members (page_url) WHERE item_id IS NULL;
CREATE INDEX IF NOT EXISTS collection_members_item_idx
    ON discovery.collection_members (item_id);

-- What a recording's own page called the cycle it is part of. It is the only
-- route to a grouping on a source that has no page for the series, and a
-- cross-check on one that does.
ALTER TABLE discovery.items ADD COLUMN IF NOT EXISTS collection_title text;
