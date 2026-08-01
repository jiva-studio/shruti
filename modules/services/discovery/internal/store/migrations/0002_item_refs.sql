-- A recording is commonly about more than one passage. One set of columns on
-- `items` could only ever say one.
--
-- Shaped like the corpus's own `track_references`: a list per recording,
-- ordered, with ONE ROW PER VERSE. Ranges are expanded before they get here, so
-- "BG 1.18-78" is sixty-one rows and every one of them is findable on its own.

CREATE TABLE IF NOT EXISTS discovery.item_refs (
    item_id   bigint NOT NULL REFERENCES discovery.items(id) ON DELETE CASCADE,
    ref_idx   integer NOT NULL,
    source_id text NOT NULL,
    tokens    text NOT NULL,
    PRIMARY KEY (item_id, ref_idx)
);

CREATE INDEX IF NOT EXISTS item_refs_lookup_idx ON discovery.item_refs (source_id, tokens);

INSERT INTO discovery.item_refs (item_id, ref_idx, source_id, tokens)
SELECT id, 0, ref_source, ref_tokens
FROM discovery.items
WHERE ref_source IS NOT NULL AND ref_tokens IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE discovery.items DROP COLUMN IF EXISTS ref_source;
ALTER TABLE discovery.items DROP COLUMN IF EXISTS ref_part;
ALTER TABLE discovery.items DROP COLUMN IF EXISTS ref_tokens;
