-- A cycle of recordings: a course, a seminar, a set of talks given together.
--
-- Its identity is the page that presents it, when there is one. Where an
-- archive names the cycle on each part and has no page for it, the title and
-- the speaker have to serve instead — the speaker by key rather than by
-- spelling, since two lecturers can give courses of the same name.

CREATE TABLE IF NOT EXISTS discovery.collections (
    id          bigserial PRIMARY KEY,
    source_id   text REFERENCES discovery.sources(id) ON DELETE CASCADE,
    url         text,
    title       text NOT NULL DEFAULT '',
    description text,
    author      text,
    author_key  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Two identities, two indexes: a cycle with a page of its own is keyed by that
-- page; one reconstructed from what its parts call it is keyed by the name they
-- used and by whose it is.
CREATE UNIQUE INDEX IF NOT EXISTS collections_url_idx
    ON discovery.collections (source_id, url) WHERE url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS collections_title_idx
    ON discovery.collections (source_id, title, coalesce(author_key, '')) WHERE url IS NULL;

-- Members are stored by page address because a part may not be indexed yet;
-- item_id is filled in whenever it is.
--
-- The count is not stored. A number kept alongside the rows it counts is a
-- number that will disagree with them.
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
