-- One speaker was arriving under four names. The archive writes whatever the
-- person who filed the recording wrote — "Radha Gopinath Prabhu", "HG Radha
-- Gopinath Das", "Radha Gopinath Pr" — and the normalizer copies it, which is
-- right: it must not guess at a name nobody wrote. But 608 spellings covered
-- rather fewer people, and "everything by this speaker" returned a third of it.
--
-- The forms of address are not part of the name. His Grace, His Holiness, Sri,
-- Srila and Prabhu are how one addresses a person, not how one identifies
-- them; Swami and Das are worth keeping in what we display, and still must not
-- separate a talk filed under one from a talk filed under the other. So the
-- stored name is left exactly as found and a key is derived beside it.
--
-- The key is deliberately coarser than the name. It cannot tell a hypothetical
-- "Govinda Swami" from "Govinda Prabhu" — but the names themselves still can,
-- and a search that finds both is a better failure than one that finds half of
-- one.

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
    -- Dasi and Mataji say the speaker is a woman, and that is the one thing in
    -- a form of address that distinguishes rather than decorates: folding them
    -- away merged "Govinda Prabhu" with "HG Govinda Dasi Mataji", two people.
    -- The marker is levelled to one token instead of dropped, so that "Kalindi
    -- Mataji" and "Kalindi Devi Dasi" still meet.
    female := k ~ '(^|\s)(dasi|mataji|mtj)(\s|\.|$)';
    -- Both ends are stripped until neither changes: "HG Sri Radha Gopinath
    -- Devi Dasi" carries two of each, and one pass would leave one of each.
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

-- A cycle's identity moves onto the key for the same reason. "Gaur Purnima
-- Festival" by "Shyamananda Prabhu" and by "HG Shyamananda Das" were two
-- cycles; folding the spellings folds them. Members move to the lowest id and
-- the emptied rows go, so the unique index below has something to be true of.
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
