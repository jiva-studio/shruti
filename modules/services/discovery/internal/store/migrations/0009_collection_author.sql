-- A cycle is a name AND a speaker. "Секреты гармонии" by Алексей Мередов and
-- "Секреты гармонии в семье" by Олег Торсунов are different courses that
-- happen to start with the same words, and nothing but the speaker separates
-- them.
--
-- Cycles reconstructed from what their parts called them were keyed on the name
-- alone and carried no speaker at all, so two lecturers using one title for
-- their own course would have been folded into one.

UPDATE discovery.collections c
SET author = (
    SELECT i.author
    FROM discovery.collection_members m
    JOIN discovery.items i ON i.id = m.item_id
    WHERE m.collection_id = c.id AND i.author IS NOT NULL
    GROUP BY i.author ORDER BY count(*) DESC LIMIT 1)
WHERE c.url IS NULL AND c.author IS NULL;

DROP INDEX IF EXISTS discovery.collections_title_idx;
CREATE UNIQUE INDEX IF NOT EXISTS collections_title_idx
    ON discovery.collections (source_id, title, coalesce(author, ''))
    WHERE url IS NULL;
