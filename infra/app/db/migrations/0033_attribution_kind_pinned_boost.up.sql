-- Rename attribution kinds to the search-industry pin/boost vocabulary:
--   'question' -> 'pinned'  (matched query is authoritative; SHORT path)
--   'topic'    -> 'boost'   (matched topic boosts fanout scores)
-- Mirrors the lectorium-mcp library.db migration (migrateAttributionKindToPinnedBoost).
--
-- Postgres can drop/re-add a CHECK and UPDATE in place — no table rebuild.
-- attributions.refs (JSONB) is untouched; this is metadata-only.
ALTER TABLE attributions DROP CONSTRAINT attributions_kind_check;
UPDATE attributions SET kind = 'pinned' WHERE kind = 'question';
UPDATE attributions SET kind = 'boost'  WHERE kind = 'topic';
ALTER TABLE attributions ADD CONSTRAINT attributions_kind_check CHECK (kind IN ('pinned', 'boost'));
