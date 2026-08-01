-- A speaker becomes a row, and recordings point at it. Filtering by speaker is
-- then an equality on a foreign key rather than a text match folded in the
-- WHERE clause, which cost both search lanes their index on items.
--
-- The keys are a table because a person has more than one spelling, and because
-- that is what lets two people be joined into one without the next recrawl
-- recreating the one that was removed.

CREATE TABLE IF NOT EXISTS discovery.authors (
    id         bigserial PRIMARY KEY,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every spelling that resolves to a person. Global rather than per source: the
-- same speaker on two archives is one speaker.
CREATE TABLE IF NOT EXISTS discovery.author_keys (
    key       text PRIMARY KEY,
    author_id bigint NOT NULL REFERENCES discovery.authors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS author_keys_author_idx ON discovery.author_keys (author_id);

ALTER TABLE discovery.items
    ADD COLUMN IF NOT EXISTS author_id bigint REFERENCES discovery.authors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS items_author_id_idx
    ON discovery.items (author_id) WHERE author_id IS NOT NULL;

-- The name starts as the commonest spelling the archive used, rather than a
-- canonical form invented here. It is a starting value; the row is editable.
-- Joining the two inserts on the name is sound: the key is a pure function of
-- the name, so two keys cannot share a spelling.
WITH modal AS (
    SELECT author_key, (array_agg(author ORDER BY n DESC, author))[1] AS name
    FROM (
        SELECT author_key, author, count(*) AS n
        FROM discovery.items
        WHERE author_key IS NOT NULL
        GROUP BY author_key, author
    ) t
    GROUP BY author_key
), fresh AS (
    SELECT m.author_key, m.name FROM modal m
    WHERE NOT EXISTS (SELECT 1 FROM discovery.author_keys k WHERE k.key = m.author_key)
), made AS (
    INSERT INTO discovery.authors (name)
    SELECT name FROM fresh
    RETURNING id, name
)
INSERT INTO discovery.author_keys (key, author_id)
SELECT f.author_key, made.id
FROM fresh f JOIN made ON made.name = f.name
ON CONFLICT (key) DO NOTHING;

UPDATE discovery.items i
SET author_id = k.author_id
FROM discovery.author_keys k
WHERE i.author_key = k.key AND i.author_id IS DISTINCT FROM k.author_id;
