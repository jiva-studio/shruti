-- A key derived from the written name, with the forms of address folded away,
-- so that one speaker filed under several spellings is one speaker. The name
-- itself is left exactly as the archive wrote it.

CREATE OR REPLACE FUNCTION discovery.author_key(a text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $fn$
DECLARE
    k      text;
    prev   text;
    female boolean;
BEGIN
    IF a IS NULL THEN
        RETURN NULL;
    END IF;
    k := lower(a);
    -- Dasi and Mataji mark a woman, so they distinguish rather than decorate.
    -- Levelled to one token rather than dropped, so that "Kalindi Mataji" and
    -- "Kalindi Devi Dasi" meet while "Govinda Prabhu" stays apart.
    female := k ~ '(^|\s)(dasi|mataji|mtj)(\s|\.|$)';
    -- Until neither end changes: a name can carry two of each.
    LOOP
        prev := k;
        k := regexp_replace(k,
            '^\s*(his\s+grace|his\s+holiness|her\s+grace|h\s*\.?\s*g|h\s*\.?\s*h|sri|shri|srila|sriman|srimati|sripad|dr)\s*\.?\s+', '');
        k := regexp_replace(k,
            '\s+(prabhuji|prabhu|pr|maharaja|maharaj|goswami|swami|sw|dasa|dasi|das|ds|mataji|mtj|devi|adhikari)\s*\.?\s*$', '');
        EXIT WHEN k = prev;
    END LOOP;
    k := btrim(regexp_replace(regexp_replace(k, '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g'));
    IF female AND k <> '' THEN
        k := k || ' dasi';
    END IF;
    RETURN nullif(k, '');
END
$fn$;

ALTER TABLE discovery.items
    ADD COLUMN IF NOT EXISTS author_key text
    GENERATED ALWAYS AS (discovery.author_key(author)) STORED;

CREATE INDEX IF NOT EXISTS items_author_key_idx
    ON discovery.items (author_key) WHERE author_key IS NOT NULL;

ALTER TABLE discovery.collections
    ADD COLUMN IF NOT EXISTS author_key text
    GENERATED ALWAYS AS (discovery.author_key(author)) STORED;

-- A cycle's identity moves onto the key too. Members move to the lowest id and
-- the emptied rows go, so the unique index below holds.
WITH grp AS (
    SELECT id,
           first_value(id) OVER (PARTITION BY source_id, title, coalesce(discovery.author_key(author), '')
                                 ORDER BY id) AS keep
    FROM discovery.collections
    WHERE url IS NULL
), moving AS (
    SELECT g.keep, m.page_url, m.item_id,
           row_number() OVER (PARTITION BY g.keep ORDER BY g.id, m.ordinal) AS rn
    FROM grp g
    JOIN discovery.collection_members m ON m.collection_id = g.id
    WHERE g.id <> g.keep
)
INSERT INTO discovery.collection_members (collection_id, ordinal, page_url, item_id)
SELECT mv.keep,
       (SELECT coalesce(max(k.ordinal), -1) FROM discovery.collection_members k
        WHERE k.collection_id = mv.keep) + mv.rn,
       mv.page_url, mv.item_id
FROM moving mv
WHERE mv.item_id IS NULL
   OR NOT EXISTS (SELECT 1 FROM discovery.collection_members k
                  WHERE k.collection_id = mv.keep AND k.item_id = mv.item_id);

DELETE FROM discovery.collections c
WHERE c.url IS NULL
  AND c.id <> (SELECT min(o.id) FROM discovery.collections o
               WHERE o.url IS NULL
                 AND o.source_id IS NOT DISTINCT FROM c.source_id
                 AND o.title = c.title
                 AND coalesce(discovery.author_key(o.author), '') = coalesce(discovery.author_key(c.author), ''));

DROP INDEX IF EXISTS discovery.collections_title_idx;
CREATE UNIQUE INDEX IF NOT EXISTS collections_title_idx
    ON discovery.collections (source_id, title, coalesce(author_key, ''))
    WHERE url IS NULL;
