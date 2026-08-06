-- A speaker is a row, and recordings point at it.
--
-- An archive writes one person as "Radhanath Swami", "Radhanath Sw",
-- "Radhanath Maharaja" and "HH Radhanath Swami". Filtering by the text of one
-- spelling returns a fraction of their talks, and folding the spellings inside
-- a WHERE clause costs the query its index. So the folding happens on the way
-- in, and the filter is an equality on a foreign key.

CREATE TABLE IF NOT EXISTS discovery.authors (
    id         bigserial PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every spelling that resolves to a person. A table rather than a column
-- because a person has more than one, and because that is what lets two people
-- be joined into one without the next recrawl recreating the one removed.
--
-- Global rather than per source: the same speaker on two archives is one
-- speaker.
CREATE TABLE IF NOT EXISTS discovery.author_keys (
    key       text PRIMARY KEY,
    author_id bigint NOT NULL REFERENCES discovery.authors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS author_keys_author_idx ON discovery.author_keys (author_id);

-- A recording can have more than one speaker: a conversation, a joint class, a
-- festival lecture given by four people in turn.
--
-- No ordinal. Who is named first carries no meaning worth storing, and a set is
-- what this is.
CREATE TABLE IF NOT EXISTS discovery.item_authors (
    item_id   bigint NOT NULL REFERENCES discovery.items(id) ON DELETE CASCADE,
    author_id bigint NOT NULL REFERENCES discovery.authors(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, author_id)
);

CREATE INDEX IF NOT EXISTS item_authors_author_idx ON discovery.item_authors (author_id, item_id);
